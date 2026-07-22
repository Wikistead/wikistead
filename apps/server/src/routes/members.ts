// Member management + invites (P1.4) — the Admin Console's core API. EVERY route
// here is admin-only (requireTenantAdmin): a non-admin member must not see the
// member list, issue/revoke invites, change roles, or remove anyone. Authorization
// is OpenFGA (tenant#admin), re-checked per request, so a demotion takes effect
// immediately (the cached session role is cosmetic).
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import type { OpenFgaClient } from '@openfga/sdk'
import { writeTuples, deleteTuples, readUserTuplesByType, isTenantAdmin } from '@wikistead/authz'
import type { TenantDb } from '../db/index.js'
import type { SearchDriver } from '../search/index.js'
import { enqueueOutbox, processOutboxAsync } from '../search/outbox.js'
import { reindexPublishedPages } from './spaces.js'
import { groupFgaId } from '../auth/group-sync.js'
import { createInvite, revokeInvite, type InviteRole } from '../auth/invites.js'
import { destroyMemberSessions } from '../auth/session.js'
import { auditIfEntitled } from '../audit/outbox.js'
import { emit } from '@wikistead/events'

const ROLES: InviteRole[] = ['admin', 'member']

// Admin gate — the Fastify (req, reply) shape over the shared tenant-admin predicate (#383). tenant#admin is the
// authority (raw relation, not a Capability). Returns false + sends 403 so a route can early-return.
async function requireTenantAdmin(req: FastifyRequest, reply: FastifyReply): Promise<boolean> {
  if (await isTenantAdmin(req.server.fga, req.user.sub, req.tenant.id)) return true
  await reply.code(403).send({ error: 'admin only' })
  return false
}

async function adminCount(req: FastifyRequest): Promise<number> {
  const [{ n }] = await req.db.sql<[{ n: number }]>`
    SELECT count(*)::int AS n FROM members WHERE role = 'admin'`
  return n
}

// #396 (#378 follow-up): sweep a removed member's DIRECT space/page grants. OpenFGA's Read supports a
// user + object-type query (readUserTuplesByType), so the removed sub's grants are enumerated in two
// paginated queries — no reverse index, no full scan. The shared FGA store spans TENANTS, so only
// tuples on resources this tenant owns are deleted (the RLS-scoped id filter below; a same-sub grant
// in another tenant is untouched). `restricted` tuples are DENIES, not grants — they are deliberately
// KEPT, so a later re-enrollment of the same sub stays restricted where it was. Deletes are per-tuple
// + idempotent (the #378 discipline: drift can never block a removal), and every touched resource is
// reindexed through the outbox (permission REVOCATION must reach search synchronously — the invariant).
// Runs post-commit: membership/tenant tuples + sessions are already gone (the hard cutoff); this sweep
// removes the residual grants that would otherwise wake up on a re-enrollment (the authz leak).
export async function sweepMemberDirectGrants(
  db: TenantDb,
  fga: OpenFgaClient,
  driver: SearchDriver,
  args: { tenantId: string; sub: string },
): Promise<void> {
  const user = `user:${args.sub}`
  const [spaceTuples, pageTuples] = await Promise.all([
    readUserTuplesByType(fga, user, 'space:'),
    readUserTuplesByType(fga, user, 'page:'),
  ])
  const id = (object: string) => object.slice(object.indexOf(':') + 1)
  // Tenant-ownership filter: req.db is RLS-scoped, so these SELECTs return ONLY this tenant's ids.
  const spaceIds = [...new Set(spaceTuples.map((t) => id(t.object)))]
  const pageIds = [...new Set(pageTuples.map((t) => id(t.object)))]
  const ownedSpaces = new Set(
    spaceIds.length ? (await db.sql<{ id: string }[]>`SELECT id FROM spaces WHERE id = ANY(${spaceIds})`).map((r) => r.id) : [],
  )
  const ownedPages = new Set(
    pageIds.length ? (await db.sql<{ id: string }[]>`SELECT id FROM pages WHERE id = ANY(${pageIds})`).map((r) => r.id) : [],
  )
  const doomed = [
    ...spaceTuples.filter((t) => ownedSpaces.has(id(t.object))),
    ...pageTuples.filter((t) => ownedPages.has(id(t.object)) && t.relation !== 'restricted'),
  ]
  for (const t of doomed) {
    await deleteTuples(fga, [t]).catch((err) => {
      // Never silent (an undeleted grant is the leak this exists to close) — but never blocking either.
      console.error('[members:sweep] direct-grant delete failed (residual grant remains)', { tuple: t, err })
    })
  }
  // Synchronous reindex of everything whose viewer set may have changed: touched pages directly,
  // touched spaces via their published pages (the revokeSpaceAccess pattern).
  const touchedPages = doomed.filter((t) => t.object.startsWith('page:')).map((t) => id(t.object))
  if (touchedPages.length) {
    const entries: { oid: string; pageId: string }[] = []
    await db.tx(async (tx) => {
      for (const pageId of new Set(touchedPages)) {
        entries.push({ oid: await enqueueOutbox(tx, { tenantId: args.tenantId, pageId, operation: 'upsert' }), pageId })
      }
    })
    for (const e of entries) processOutboxAsync(driver, e.oid, { tenantId: args.tenantId, pageId: e.pageId, operation: 'upsert' })
  }
  const touchedSpaces = new Set(doomed.filter((t) => t.object.startsWith('space:')).map((t) => id(t.object)))
  for (const spaceId of touchedSpaces) await reindexPublishedPages(db, driver, args.tenantId, spaceId)
}

export async function membersPlugin(app: FastifyInstance) {
  // ── Members ────────────────────────────────────────────────────────────────
  app.get('/members', async (req, reply) => {
    if (!(await requireTenantAdmin(req, reply))) return
    const rows = await req.db.sql<
      { sub: string; email: string | null; display_name: string | null; picture_url: string | null; role: string; created_at: Date }[]
    >`SELECT sub, email, display_name, picture_url, role, created_at FROM members ORDER BY created_at`
    return { members: rows }
  })

  // #379 / ADR-150: resolve a SPECIFIC set of author subs to display identity — any tenant MEMBER may
  // call (not admin-only; no `config.guest` → guests/anon are structurally 401, the public surface never
  // resolves). Returns ONLY the subs that are members of the CALLER'S tenant (RLS) AND have CUSTOMIZED
  // their identity (display_name_override OR an uploaded avatar): `present ⟺ (member AND customized)`,
  // so an ABSENT sub is ambiguous (non-member / cross-tenant / un-customized member — all omitted
  // IDENTICALLY, no membership-confirmation oracle) while a PRESENT sub only confirms what the caller
  // already sees as an author. displayName = override ?? OIDC display_name — NEVER email or an
  // email-local-part (an avatar-only customizer's displayName is their IdP name, not a chosen one — the
  // client may still prefer its own label). No role/email/session data — those stay admin-only.
  app.post<{ Body: { subs?: string[] } }>('/members/identities', async (req, reply) => {
    const raw = Array.isArray(req.body?.subs) ? req.body.subs : null
    if (!raw) return reply.code(400).send({ error: 'subs required' })
    // Cap the batch (ADR anti-test: enforced, not silent) + drop obvious non-member principals so a
    // guest/anon pseudonym never even reaches the query.
    if (raw.length > 200) return reply.code(400).send({ error: 'too many subs (max 200)' })
    const subs = [...new Set(raw.map(String).filter((s) => s && !s.startsWith('guest:') && !s.startsWith('anon:')))]
    if (subs.length === 0) return { identities: {} }
    const rows = await req.db.sql<{ sub: string; display_name: string | null; display_name_override: string | null; avatar_image_key: string | null }[]>`
      SELECT sub, display_name, display_name_override, avatar_image_key FROM members
      WHERE sub = ANY(${subs}) AND (display_name_override IS NOT NULL OR avatar_image_key IS NOT NULL)`
    const identities: Record<string, { displayName: string | null; hasAvatar: boolean }> = {}
    for (const r of rows) identities[r.sub] = { displayName: r.display_name_override ?? r.display_name ?? null, hasAvatar: r.avatar_image_key != null }
    return { identities }
  })

  // Change a member's role (admin ↔ member). ADR-003: DB first, FGA last, inside one
  // tx → a FGA failure rolls the role change back. Cannot demote the last admin
  // (that would lock the tenant out of its own administration).
  app.patch<{ Params: { sub: string }; Body: { role?: string } }>('/members/:sub', async (req, reply) => {
    if (!(await requireTenantAdmin(req, reply))) return
    const role = req.body?.role
    if (role !== 'admin' && role !== 'member') return reply.code(400).send({ error: 'invalid role' })

    const [existing] = await req.db.sql<[{ role: string }?]>`
      SELECT role FROM members WHERE sub = ${req.params.sub}`
    if (!existing) return reply.code(404).send({ error: 'member not found' })
    if (existing.role === role) return { ok: true } // no-op

    if (existing.role === 'admin' && role === 'member' && (await adminCount(req)) <= 1) {
      return reply.code(409).send({ error: 'cannot demote the last admin' })
    }

    await req.db.tx(async (tx) => {
      await tx`UPDATE members SET role = ${role}, updated_at = now() WHERE sub = ${req.params.sub}`
      const adminTuple = [{ user: `user:${req.params.sub}`, relation: 'admin', object: `tenant:${req.tenant.id}` }]
      if (role === 'admin') await writeTuples(req.server.fga, adminTuple)
      else await deleteTuples(req.server.fga, adminTuple)
      // Durable compliance audit (#177), in-tx + EE-gated.
      await auditIfEntitled(tx, req.tenant, { actor: `user:${req.user.sub}`, action: 'member.role_changed', target: `user:${req.params.sub}` })
    })
    emit({ type: 'member.role_changed', tenantId: req.tenant.id, actorId: req.user.sub, targetSub: req.params.sub, role })
    return { ok: true }
  })

  // Remove a member. ADR-003 ordering; then revoke ALL their live sessions so the
  // removal is immediate (not at TTL). Cannot remove the last admin.
  app.delete<{ Params: { sub: string } }>('/members/:sub', async (req, reply) => {
    if (!(await requireTenantAdmin(req, reply))) return
    const [existing] = await req.db.sql<[{ role: string; groups: string[] }?]>`
      SELECT role, groups FROM members WHERE sub = ${req.params.sub}`
    if (!existing) return reply.code(404).send({ error: 'member not found' })
    if (existing.role === 'admin' && (await adminCount(req)) <= 1) {
      return reply.code(409).send({ error: 'cannot remove the last admin' })
    }

    let revokedKeyIds: string[] = []
    await req.db.tx(async (tx) => {
      await tx`DELETE FROM members WHERE sub = ${req.params.sub}`
      // #362 E1: the removed member's watches go with them (BLIND delete is correct here — the member is
      // gone, unlike the per-watcher-checked revocation sweep). Stops their inbox rows from ever growing.
      await tx`DELETE FROM watches WHERE member_sub = ${req.params.sub}`
      // #464 / ADR-175 §6: erase the removed member's personal reading history in this SAME tx, so a
      // who-viewed record never outlives the member (the #474/#477 cleanup family). Their roster rows
      // (page_view_roster is FORCE-RLS → this tenant only) AND any not-yet-drained analytics_outbox rows
      // for them (tenant-scoped explicitly — the outbox has no RLS). The aggregate counts (page_view_daily)
      // are anonymous and stay. The drain's membership re-check is the second defence against a fold that
      // lands after this delete (erasure-race double-defence, reviewer condition 1).
      await tx`DELETE FROM page_view_roster WHERE member_sub = ${req.params.sub}`
      await tx`DELETE FROM analytics_outbox WHERE tenant_id = ${req.tenant.id} AND viewer_class = 'member' AND member_sub = ${req.params.sub}`
      // #474: the member's API keys go too. Removal already strips every other credential — sessions
      // (destroyMemberSessions below), membership and group tuples, direct grants (#396) — but an API
      // key is a longer-lived credential than a session, and it kept authenticating the removed sub.
      // REVOKED, not deleted, so the row stays auditable exactly as a self-service revoke leaves it.
      const revoked = await tx<{ id: string }[]>`
        UPDATE api_keys SET revoked_at = now()
        WHERE owner_user_id = ${req.params.sub} AND revoked_at IS NULL
        RETURNING id`
      // Remove the membership grants. Only delete the admin tuple if it exists —
      // FGA rejects the whole batch if asked to delete a non-existent tuple.
      const tuples = [{ user: `user:${req.params.sub}`, relation: 'member', object: `tenant:${req.tenant.id}` }]
      if (existing.role === 'admin') tuples.push({ user: `user:${req.params.sub}`, relation: 'admin', object: `tenant:${req.tenant.id}` })
      await deleteTuples(req.server.fga, tuples) // FGA last → rollback on failure
      // #378: also drop the member's group-membership tuples (group:<id>#member@user:<sub>), derived from
      // members.groups (the same source syncMemberGroups writes from). Left behind they (a) keep granting
      // group-inherited access after removal (an authz leak) and (b) break a later RE-registration of the same
      // sub: syncMemberGroups(prev=[], next=[…]) re-writes tuples that still exist → FGA duplicate-write error →
      // the login tx rolls back → permanent login failure. Delete each INDIVIDUALLY (ignore a missing one) so
      // any drift between members.groups and FGA can never block removal or survive it.
      for (const g of existing.groups ?? []) {
        await deleteTuples(req.server.fga, [{ user: `user:${req.params.sub}`, relation: 'member', object: `group:${groupFgaId(req.tenant.id, g)}` }]).catch(() => {})
      }
      // Durable compliance audit (#177), in-tx + EE-gated.
      await auditIfEntitled(tx, req.tenant, { actor: `user:${req.user.sub}`, action: 'member.removed', target: `user:${req.params.sub}` })
      for (const k of revoked) {
        await auditIfEntitled(tx, req.tenant, { actor: `user:${req.user.sub}`, action: 'api_key.revoked', target: `api_key:${k.id}` })
      }
      revokedKeyIds = revoked.map((k) => k.id)
    })
    await destroyMemberSessions(req.server.valkey, req.tenant.id, req.params.sub)
    // #396: post-commit residual sweep — the removed sub's direct space/page grants (this tenant only)
    // + the synchronous search reindex. Failures are logged per-tuple, never block the removal.
    await sweepMemberDirectGrants(req.db, req.server.fga, req.server.searchDriver, { tenantId: req.tenant.id, sub: req.params.sub })
    for (const keyId of revokedKeyIds) emit({ type: 'api_key.revoked', tenantId: req.tenant.id, keyId, actorId: req.user.sub })
    emit({ type: 'member.removed', tenantId: req.tenant.id, actorId: req.user.sub, targetSub: req.params.sub })
    return reply.code(204).send()
  })

  // #464 / ADR-175 §6 (DSAR): a tenant admin erases ONE member's page-analytics reading history on request,
  // WITHOUT removing the member (unlike DELETE /members/:sub — the member keeps their access). Same erasure
  // as the removal path — roster rows + not-yet-drained outbox rows — in one tx, with an EE-gated audit row.
  // The un-drained outbox purge stops a pending fold from re-creating the roster (the member still exists,
  // so the drain's membership re-check does not apply here). Tenant-admin only.
  app.delete<{ Params: { sub: string } }>('/admin/analytics/member/:sub', async (req, reply) => {
    if (!(await requireTenantAdmin(req, reply))) return
    await req.db.tx(async (tx) => {
      await tx`DELETE FROM page_view_roster WHERE member_sub = ${req.params.sub}`
      await tx`DELETE FROM analytics_outbox WHERE tenant_id = ${req.tenant.id} AND viewer_class = 'member' AND member_sub = ${req.params.sub}`
      await auditIfEntitled(tx, req.tenant, { actor: `user:${req.user.sub}`, action: 'analytics.erased', target: `user:${req.params.sub}` })
    })
    return reply.code(204).send()
  })

  // ── Invites ──────────────────────────────────────────────────────────────
  app.get('/members/invites', async (req, reply) => {
    if (!(await requireTenantAdmin(req, reply))) return
    const rows = await req.db.sql<
      { id: string; email: string | null; role: string; invited_by: string; expires_at: Date; created_at: Date }[]
    >`SELECT id, email, role, invited_by, expires_at, created_at
        FROM invites WHERE status = 'pending' AND expires_at > now() ORDER BY created_at DESC`
    return { invites: rows }
  })

  // Create an invite. Seat cap is enforced in createInvite (UNLIMITED self-host
  // skips it). Email is BEST-EFFORT (P1.3) — the invite link is authoritative, so
  // we always return it; `emailed` reports whether delivery was attempted+ok.
  app.post<{ Body: { email?: string; role?: string } }>('/members/invites', async (req, reply) => {
    if (!(await requireTenantAdmin(req, reply))) return
    const role = (req.body?.role ?? 'member') as InviteRole
    if (!ROLES.includes(role)) return reply.code(400).send({ error: 'invalid role' })
    const email = req.body?.email?.trim() || null

    // Issuing does NOT hard-block at the seat cap (ADR-034: accept is the fortress); it
    // returns `seatWarning` so the UI can warn the admin they are over-issuing.
    let token: string
    let seatWarning = false
    try {
      ;({ token, seatWarning } = await createInvite(req.db, { tenantId: req.tenant.id, plan: req.tenant.plan, invitedBy: req.user.sub, email, role }))
    } catch {
      return reply.code(500).send({ error: 'could not create invite' })
    }

    const scheme = process.env.NODE_ENV === 'production' ? 'https' : 'http'
    const inviteUrl = `${scheme}://${req.headers.host}/invite?token=${token}`

    let emailed = false
    if (email) {
      try {
        await req.server.email.send({
          to: email,
          subject: `You're invited to ${req.tenant.slug} on wikistead`,
          text: `You've been invited to join ${req.tenant.slug}. Open this link to accept:\n\n${inviteUrl}`,
          html: `<p>You've been invited to join <strong>${req.tenant.slug}</strong> on wikistead.</p><p><a href="${inviteUrl}">Accept your invitation</a></p>`,
        })
        emailed = true
      } catch (err) {
        req.log.warn({ err }, 'invite email send failed — link still valid')
      }
    }
    emit({ type: 'invite.created', tenantId: req.tenant.id, actorId: req.user.sub, role })
    return reply.code(201).send({ inviteUrl, emailed, seatWarning })
  })

  app.delete<{ Params: { id: string } }>('/members/invites/:id', async (req, reply) => {
    if (!(await requireTenantAdmin(req, reply))) return
    const ok = await revokeInvite(req.db, req.params.id)
    if (!ok) return reply.code(404).send({ error: 'invite not found or not pending' })
    emit({ type: 'invite.revoked', tenantId: req.tenant.id, actorId: req.user.sub })
    return reply.code(204).send()
  })
}
