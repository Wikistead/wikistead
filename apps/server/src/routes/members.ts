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
import { isLastAdmin, lastAdminRefusal } from '../auth/last-admin.js' // #573: ONE last-admin predicate; #603: the refusal says why
import { createInvite, revokeInvite, type InviteRole } from '../auth/invites.js'
import { destroyMemberSessions } from '../auth/session.js'
import { auditIfEntitled } from '../audit/outbox.js'
import { resolveEntitlements } from '@wikistead/entitlements' // #520: EE gate for the tenant analytics roll-up
import { rollupPageViews, validateRollupQuery, isUniqueMode, type RollupQuery } from '../analytics/rollup.js' // #520 / ADR-189
import { emit } from '@wikistead/events'
import { productName } from '../product-name.js' // #575: the name is a deployment value

const ROLES: InviteRole[] = ['admin', 'member']

// Admin gate — the Fastify (req, reply) shape over the shared tenant-admin predicate (#383). tenant#admin is the
// authority (raw relation, not a Capability). Returns false + sends 403 so a route can early-return.
async function requireTenantAdmin(req: FastifyRequest, reply: FastifyReply): Promise<boolean> {
  if (await isTenantAdmin(req.server.fga, req.user.sub, req.tenant.id)) return true
  await reply.code(403).send({ error: 'admin only' })
  return false
}

// #573: the last-admin question has ONE answer — see isLastAdmin (auth/admin-mapping.ts), which also
// carries the rule's rationale. This surface asks it about the member it is DEMOTING or REMOVING.

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
  // #603 review: the ROW side of the same leak. A tenant-scope assignment outlives the member it was
  // made for, so the next person to hold that sub — or the same person rejoining — inherits it. The
  // tuples are swept below; the rows that own them go here, in the caller's tenant scope (RLS).
  await db.sql`DELETE FROM role_assignments
    WHERE resource_type = 'tenant' AND resource_id = ${args.tenantId} AND principal = ${`user:${args.sub}`}`
    .catch((err) => console.error('[members:sweep] tenant assignment rows remain', { sub: args.sub, err }))
  const user = `user:${args.sub}`
  const [spaceTuples, pageTuples, tenantTuples] = await Promise.all([
    readUserTuplesByType(fga, user, 'space:'),
    readUserTuplesByType(fga, user, 'page:'),
    // #603 review: this swept `space:` and `page:` and stopped there, so a removed member kept every
    // TENANT-scope grant they held — `space_creator`, `api_key_issue`, and since #604 the verbs carved
    // out of admin. Rejoining (an invite, a domain self-enrol) woke them all up silently, which is the
    // authz leak the rest of this function exists to close. The membership tuple itself is already gone
    // by the time this runs; what is left are the grants somebody made TO them.
    readUserTuplesByType(fga, user, 'tenant:'),
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
    // only THIS tenant's object, and never `member`/`admin` themselves: those are the membership the
    // removal already handled, and re-deleting them here would make this sweep responsible for a
    // decision it does not own.
    ...tenantTuples.filter((t) => id(t.object) === args.tenantId && t.relation !== 'member' && t.relation !== 'admin'),
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
    // ADR-207 rev3 (#603): `groups` joins a person to what a group confers on them (the admin-via-group
    // marker). This surface is admin-gated and the group rows themselves are already listed here, so
    // nothing new is disclosed — the screen just stops guessing.
    const rows = await req.db.sql<
      { sub: string; email: string | null; display_name: string | null; picture_url: string | null; role: string; groups: string[] | null; created_at: Date }[]
    >`SELECT sub, email, display_name, picture_url, role, groups, created_at FROM members ORDER BY created_at`
    return { members: rows }
  })

  // #579: the tenant-scope group name source. Assigning a tenant role to a GROUP needs the names the
  // members carry, and the only existing list was space-scoped and gated on that space's `manage` —
  // unusable from the admin console, where there is no space. Same projection, same sensitivity
  // argument (group names are not shown to every member), gated on tenant admin instead. Names only:
  // the id is derived server-side (group-sync.ts is the single id authority — a client that hashes
  // writes a tuple nobody holds, the #536 bug).
  app.get('/admin/groups', async (req, reply) => {
    if (!(await requireTenantAdmin(req, reply))) return
    const rows = await req.db.sql<{ g: string }[]>`
      SELECT DISTINCT unnest(groups) AS g FROM members WHERE groups IS NOT NULL ORDER BY g`
    return rows.map((r) => r.g).filter((g) => g != null && g !== '')
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

    if (existing.role === 'admin' && role === 'member' && (await isLastAdmin(req.db.sql, req.params.sub))) {
      return reply.code(409).send(await lastAdminRefusal(req.db.sql))
    }

    await req.db.tx(async (tx) => {
      // #497 §2b: a role change made HERE is a person's decision, so it also resets the provenance to
      // 'manual'. Without this the column outlives the grant it described: demoting a group-materialised
      // admin left admin_origin='mapping' behind, and re-appointing them by hand produced an admin the
      // drift sweep considered machine-owned and revoked out from under the person who appointed them.
      await tx`UPDATE members SET role = ${role}, admin_origin = 'manual', updated_at = now() WHERE sub = ${req.params.sub}`
      const adminTuple = [{ user: `user:${req.params.sub}`, relation: 'admin', object: `tenant:${req.tenant.id}` }]
      if (role === 'admin') await writeTuples(req.server.fga, adminTuple)
      else await deleteTuples(req.server.fga, adminTuple)
      // Durable compliance audit (#177), in-tx + EE-gated.
      await auditIfEntitled(tx, req.tenant, { actor: `user:${req.user.sub}`, action: 'member.role_changed', target: `user:${req.params.sub}` })
    })
    emit({ type: 'member.role_changed', tenantId: req.tenant.id, actorId: req.user.sub, targetSub: req.params.sub, role })
    return { ok: true }
  })

  // #606 / ADR-205 §2 (ruled option A): give an EXISTING member a password entrance.
  //
  // The defect this answers: a password INVITE mints a new identity, so sending one to somebody already
  // here made a second person sharing their address. Refusing that (the other half of #606) left the
  // admin with no way to do the thing they wanted — and for a SCIM or OIDC member there was no way at
  // all, which is why #605's break-glass could not be built.
  //
  // Admin only (the ruling), gated by the tenant's password switch (the same door the invite uses), and
  // available for IdP-derived subs on purpose: an SSO tenant is entirely IdP-derived, so refusing them
  // would refuse the case the feature exists for. The consequence is real and belongs in the ledger: the
  // IdP stops being the only authority for that account, so the act is audited with the admin as actor.
  app.post<{ Params: { sub: string } }>('/members/:sub/password-setup', async (req, reply) => {
    if (!(await requireTenantAdmin(req, reply))) return
    const [member] = await req.db.sql<[{ sub: string }?]>`SELECT sub FROM members WHERE sub = ${req.params.sub}`
    if (!member) return reply.code(404).send({ error: 'member not found' })
    const { mintPasswordSetup } = await import('../auth/password-reset.js')
    const minted = await mintPasswordSetup(req.db, req.params.sub)
    // One answer for every refusal a caller may not distinguish: password sign-in is off, they already
    // have a password, they have no address, or the address belongs to somebody else's credential.
    if (!minted) return reply.code(400).send({ error: 'this member cannot be given a password entrance', code: 'password_setup_unavailable' })
    const scheme = process.env.NODE_ENV === 'production' ? 'https' : 'http'
    const setupUrl = `${scheme}://${req.headers.host}/reset-password?token=${minted.token}`
    await req.db.tx(async (tx) => auditIfEntitled(tx, req.tenant, {
      actor: `user:${req.user.sub}`, action: 'member.password_enabled', target: `member:${req.params.sub}`,
    })).catch((err: unknown) => req.log.warn({ err }, 'password-setup audit failed'))
    emit({ type: 'member.password_enabled', tenantId: req.tenant.id, actorId: req.user.sub, targetSub: req.params.sub })
    return reply.code(201).send({ setupUrl, email: minted.email })
  })

  // Remove a member. ADR-003 ordering; then revoke ALL their live sessions so the
  // removal is immediate (not at TTL). Cannot remove the last admin.
  app.delete<{ Params: { sub: string } }>('/members/:sub', async (req, reply) => {
    if (!(await requireTenantAdmin(req, reply))) return
    const [existing] = await req.db.sql<[{ role: string; groups: string[] }?]>`
      SELECT role, groups FROM members WHERE sub = ${req.params.sub}`
    if (!existing) return reply.code(404).send({ error: 'member not found' })
    if (existing.role === 'admin' && (await isLastAdmin(req.db.sql, req.params.sub))) {
      return reply.code(409).send(await lastAdminRefusal(req.db.sql))
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
      // #568 / ADR-198 §1 M4: the member's PASSWORD goes too, explicitly. The composite FK cascades,
      // but relying on it leaves the deletion invisible here — and this is the transaction the #474
      // rule ("removal strips every other credential") lives in; a password is not less of a
      // credential than an API key. Written out so re-inviting the same address is never blocked by
      // UNIQUE (tenant_id, identifier), and no dormant hash outlives its member.
      await tx`DELETE FROM local_credentials WHERE member_sub = ${req.params.sub}`
      // ...and any live reset links for them. The FK cascades in the logical-isolation schema, but a
      // namespaced tenant does not replicate it, and a link that outlived its member would be a
      // credential-setting capability pointing at nobody.
      await tx`DELETE FROM password_resets WHERE member_sub = ${req.params.sub}`
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

  // #520 / ADR-189 slice 5: the TENANT-level page-view roll-up (the approved scope is "space AND tenant
  // aggregation"; the space surface is GET /spaces/:id/analytics). Existence floor = tenant#admin (403 for a
  // non-admin, matching every other /admin route here — a member already knows the tenant exists, so there is
  // nothing to hide), then the SAME EE gate and the SAME §5 manage-filter-set as the space surface via the
  // shared rollupPageViews. That filter is what keeps this honest: a tenant admin manages non-private pages
  // through `manager from space`, so PRIVATE pages they do not manage stay out of the tenant total too — the
  // aggregate is never "everything in the tenant", it is "everything you manage". Counts only, no roster.
  app.get<{ Querystring: RollupQuery }>('/admin/analytics', async (req, reply) => {
    if (!(await requireTenantAdmin(req, reply))) return
    const unique = isUniqueMode(req.query)
    if (!resolveEntitlements(req.tenant.plan).analytics) return { entitled: false, pages: 0, daily: [], unique } // EE gate
    const invalid = validateRollupQuery(req.query) // 400 before any FGA/DB work
    if (invalid) return reply.code(400).send({ error: invalid })
    // Every page in THIS tenant (req.db is RLS-scoped, so the tenant boundary is the database's, not a filter).
    const rows = await req.db.sql<{ id: string; parent_id: string | null }[]>`SELECT id, parent_id FROM pages`
    // A tenant admin manages every space, so every space's page#space links may be trusted. (The read cost
    // is (linked pages / 50) round-trips PLUS one per space — NOT "spaces, not pages"; that earlier claim
    // came from a measurement against page ids with no tuples at all. See rollup.ts for the real numbers.)
    const spaceRows = await req.db.sql<{ id: string }[]>`SELECT id FROM spaces`
    // #520 a tenant admin IS a manager of every space (`space#manager … or admin from tenant`), so the
    // per-page fan-out — worst here, this scope being the whole tenant — collapses to the private pages only.
    // The gate above already established tenant#admin, so the hint costs no extra check.
    const parentOf = new Map(rows.map((r) => [r.id, r.parent_id] as const))
    return rollupPageViews(req.db, req.server.fga, `user:${req.user.sub}`, rows.map((r) => r.id), req.query, true,
      { parentOf, managedSpaceIds: spaceRows.map((r) => r.id) })
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
  app.post<{ Body: { email?: string; role?: string; roleId?: string | null; kind?: string } }>('/members/invites', async (req, reply) => {
    if (!(await requireTenantAdmin(req, reply))) return
    const role = (req.body?.role ?? 'member') as InviteRole
    if (!ROLES.includes(role)) return reply.code(400).send({ error: 'invalid role' })
    // #568 / ADR-198 §2: which KIND of identity this invite creates. Default unchanged.
    const kind = req.body?.kind === 'local' ? 'local' as const : 'oidc' as const
    const email = req.body?.email?.trim() || null

    // Issuing does NOT hard-block at the seat cap (ADR-034: accept is the fortress); it
    // returns `seatWarning` so the UI can warn the admin they are over-issuing.
    let token: string
    let seatWarning = false
    try {
      ;({ token, seatWarning } = await createInvite(req.db, { tenantId: req.tenant.id, plan: req.tenant.plan, invitedBy: req.user.sub, email, role, roleId: req.body?.roleId ?? null, kind }))
    } catch (e) {
      // #568: a local invite that cannot work is refused with its REASON (no email, or the tenant
      // does not offer password sign-in) — the admin is looking at the screen and can fix either.
      // The blanket 500 below stays for everything else.
      const err = e as { statusCode?: number; code?: string; message?: string }
      if (err.statusCode === 400) return reply.code(400).send({ error: err.message ?? 'invalid invite', code: err.code })
      return reply.code(500).send({ error: 'could not create invite' })
    }

    const scheme = process.env.NODE_ENV === 'production' ? 'https' : 'http'
    const inviteUrl = `${scheme}://${req.headers.host}/invite?token=${token}`

    let emailed = false
    if (email) {
      try {
        // #547 / ADR-196 §7: the REQUEST path resolves per tenant too — a resolver consulted only by
        // the outbox drain would silently drop a managed-sender tenant's invite mail onto the CE
        // fallback (rev2/N-a). The boot-time app.email stays the fallback.
        const { resolveTenantEmailDriver } = await import('@wikistead/hooks')
        await resolveTenantEmailDriver({ tenantId: req.tenant.id, plan: req.tenant.plan }, req.server.email).send({
          to: email,
          subject: `You're invited to ${req.tenant.slug} on ${productName()}`,
          text: `You've been invited to join ${req.tenant.slug}. Open this link to accept:\n\n${inviteUrl}`,
          html: `<p>You've been invited to join <strong>${req.tenant.slug}</strong> on ${productName()}.</p><p><a href="${inviteUrl}">Accept your invitation</a></p>`,
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
