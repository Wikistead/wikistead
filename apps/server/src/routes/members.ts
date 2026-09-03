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
import { reindexPublishedPages, listGroupNames } from './spaces.js'
import { groupFgaId } from '../auth/group-sync.js'
import { enqueueTupleDeletes, flushTupleDeletes, type TupleIntent } from '../db/tuple-outbox.js' // #896
import { isLastAdmin, lastAdminRefusal } from '../auth/last-admin.js' // #573: ONE last-admin predicate; #603: the refusal says why
import { assertClosingIsSafe, assertNotLastExemptAdmin, anAdminHoldsAKey, memberHasAnotherWayIn, subsWithAnotherWayIn, SSO_FLOOR_REFUSAL } from '../auth/login-methods.js' // #866 / ADR-251 §3.7: a write that takes the key away can close the last way in
import { createInvite, revokeInvite, reissueInvite, hashInviteToken, type InviteRole } from '../auth/invites.js'
import { destroyMemberSessions, tenantDefaultLang } from '../auth/session.js'
import { deleteAllFactors } from '../auth/second-factors.js' // #644 the administrator reset (ADR-219 §4)
import { revokeRecoveryCodes } from '../auth/recovery-codes.js' // #650 / ADR-226 §5: the set goes with them
import { holdsAConfirmedFactor } from '../auth/factor-policy.js' // #644 / #675: the condition, named once

// #623: how many members one answer carries. Small enough that the screen paints at once, large enough
// that a normal tenant is one request.
export const MEMBERS_PAGE_LIMIT = 50
import { suspendMember, reactivateMember, LastAdminSuspensionError } from '../auth/member-suspension.js' // #627: the shared suspension verb (CE)
import { reconcilePendingScimRemovalsIfRegistered } from '../auth/scim-reconcile-seam.js' // #1053: fast-path — a promotion is one of the three trigger sites
import { auditIfEntitled } from '../audit/sink.js'
import { resolveEntitlements } from '@wikistead/entitlements' // #520: EE gate for the tenant analytics roll-up
import { emit } from '@wikistead/events'
import { productName } from '../product-name.js' // #575: the name is a deployment value
import { esc } from '../email/layout.js'
import { inviteAcceptLabel, inviteBodyText, inviteSentence, inviteSubject } from '../email/catalog.js'
import { resolveMailLocale } from '../locale.js'
import { tenantBaseUrl, noAddressReason } from '../email/base-url.js'

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
  // #634: the ROW side, with the SAME reach as the tuple side above.
  //
  // #603's review added the tenant scope here and stopped, so a removed member's space and page
  // assignment ROWS outlived them while their tuples went — a row that appears in every roster and
  // confers nothing. That is the ledger-versus-world split #596 exists to forbid, and it is where the
  // "unknown member" rows #578 had to render came from: the display was handled, the source was not.
  //
  // `origin` is deliberately NOT consulted. ADR-183 §1 says a machine-owned row is removed where the
  // machine is, and that holds while the principal exists — a mapping re-materialises what it owns. This
  // member does not exist any more: nothing will ever re-evaluate a row keyed to their sub, so leaving
  // one because a machine made it keeps a row nobody can act on and no machine will revisit. The tuples
  // are already gone regardless of origin (the sweep below never asked either), so keeping the row would
  // preserve exactly the mismatch this fixes.
  // Every scope, not a list of three: the row side is scoped by the PRINCIPAL, and this connection is
  // RLS-bound to the tenant (072_custom_roles.sql: FORCE ROW LEVEL SECURITY on tenant_id). So "this
  // member's rows, in this tenant" is the whole statement — no per-type clause to forget when a fourth
  // resource type arrives, and no second ownership rule beside the tuple filter above.
  //
  // Deliberately NOT derived from the tuples: a row whose tuple already went is exactly the orphan this
  // ticket is about, and deriving the set from `ownedSpaces` / `ownedPages` would step over it. The
  // asymmetry is real and worth naming — FGA has no tenant, so the tuple side must ask the database
  // which objects are ours; the database knows already.
  await db.sql`DELETE FROM role_assignments WHERE principal = ${user}`
    .catch((err) => console.error('[members:sweep] assignment rows remain', { sub: args.sub, err }))
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

/** #623: how many pending invitations one response may carry. */
export const INVITES_PAGE_LIMIT = 100

export async function membersPlugin(app: FastifyInstance) {
  // ── Members ────────────────────────────────────────────────────────────────
  app.get<{ Querystring: { limit?: string; cursor?: string; q?: string } }>('/members', async (req, reply) => {
    if (!(await requireTenantAdmin(req, reply))) return
    // ADR-207 rev3 (#603): `groups` joins a person to what a group confers on them (the admin-via-group
    // marker). This surface is admin-gated and the group rows themselves are already listed here, so
    // nothing new is disclosed — the screen just stops guessing.
    //
    // #614: three status columns the screen was blind to, none a new disclosure on an admin-gated list:
    //   has_password — a credential row exists (existence only; the hash never rides this SELECT, which
    //     is the reason local_credentials is its own table). The UI uses it to stop offering "add a
    //     password entrance" to somebody who already has one — a button that could only fail (#606).
    //   identity_source — who minted the identity (IdP vs this product), migration 083.
    //   deactivated_at — a SCIM-suspended member looked identical to a live one here. Rows stay listed:
    //     deactivation is a freeze, not a removal (migration 037), and hiding them would make the seat
    //     they still occupy invisible.
    //
    // A CORRECTION (#614 review, measured): the first version of this comment said a role change while
    // suspended "takes effect THEN", at reactivation. It takes effect NOW. PATCH below does not read
    // `deactivated_at`, so promoting a suspended member writes `tenant#admin` immediately — restoring a
    // tuple the deactivation removed, and lighting up every relation that unions `or admin`, while
    // `tenant#member` stays false. Sign-in is still shut (sessions destroyed, API keys revoked, the
    // login gate), and `isLastAdmin` counts `deactivated_at IS NULL`, so no lockout follows; but the
    // contract "suspended means the grants are off" is not held. Whether a write-time guard belongs
    // here is an authz ruling, not an implementation detail — raised on the ticket rather than decided.
    // #623 (review ruling), slice 2: this list grew with the tenant and the screen drew all of it —
    // the motivating case for the whole ticket ("does the page stretch forever as members are added?").
    //
    // LIMIT with a CURSOR, never OFFSET: members are added while somebody is reading, and an offset
    // silently repeats or skips a row when the list shifts. `created_at` is not unique (a bulk import
    // stamps many rows in the same instant), so the cursor carries `sub` as the tiebreaker the ORDER BY
    // needs — without it two members sharing a timestamp straddle a page boundary forever.
    //
    // The search moves in the same change, because it cannot move separately. Filtering on the client
    // while the server pages turns "find this person" into "find this person among the ones already
    // fetched" — the same words, a quietly different question. What it matches is what the client
    // filter matched: display name, email, sub. This is the admin console, where every one of those is
    // already on screen, so naming them in a query is not an enumeration oracle; opening the same search
    // to a non-admin surface would be a different question and needs its own review.
    const q = (req.query as { q?: string } | undefined)?.q?.trim() ?? ''
    const rawLimit = Number.parseInt((req.query as { limit?: string } | undefined)?.limit ?? '', 10)
    const limit = Math.min(200, Math.max(1, Number.isFinite(rawLimit) ? rawLimit : MEMBERS_PAGE_LIMIT))
    const cursor = (req.query as { cursor?: string } | undefined)?.cursor
    const at = cursor?.indexOf('|') ?? -1
    // #623 slice 12b's sibling. The cursor used to carry `created_at.toISOString()`, which stops at
    // MILLISECONDS — `created_at` is a timestamptz(6) and Postgres keeps microseconds. Cast back with
    // `::timestamptz` the parameter named an earlier instant than the row it came from, so the row on
    // the page boundary compared as greater than its own cursor and came round again. Measured on this
    // route with rows a microsecond apart: the walk returned the same three members forever and six of
    // the nine were unreachable.
    //
    // An epoch numeric is a NUMBER to the driver, so nothing rounds it, and `to_timestamp` puts every
    // microsecond back. Same spelling as `/spaces`, deliberately: two cursors is how one of them stays
    // wrong.
    const after = cursor && at > 0 ? { at: cursor.slice(0, at), sub: cursor.slice(at + 1) } : null
    const rows = await req.db.sql<
      {
        sub: string; email: string | null; display_name: string | null; picture_url: string | null
        role: string; groups: string[] | null; created_at: Date
        identity_source: string; deactivated_at: Date | null; deactivation_reason: string | null; has_password: boolean
        has_factor: boolean; cursor_at: string; pending_scim_removal_at: Date | null
      }[]
    >`SELECT m.sub, m.email, m.display_name, m.picture_url, m.role, m.groups, m.created_at,
             -- the value the cursor is built from, carried out of SQL so no driver rounds it
             extract(epoch from m.created_at)::text AS cursor_at,
             -- #627: WHOSE suspension it is decides whether the console may offer to undo it
             m.identity_source, m.deactivated_at, m.deactivation_reason, (lc.member_sub IS NOT NULL) AS has_password,
             -- #1054 / ADR-275 rev3 §4 (A8): the timestamp only, never the removal reason column —
             -- the console's own non-disclosure line matches the out-of-band notice's (#1051): a member
             -- row may say "pending", never which floor or how many administrators remain.
             m.pending_scim_removal_at,
             -- #644 existence only, the same shape as has_password one line up — nothing about
             -- the factor itself rides this SELECT. It exists so the console does not offer to reset
             -- somebody who holds nothing: that call SUCCEEDS with a count of zero, which is worse than
             -- a button that fails, because it reports having done something.
             -- The condition is NOT spelled here (#675): it is a named fragment, and the comment on it
             -- says why this question takes the confirmed half of the rule and not the host half.
             ${holdsAConfirmedFactor(req.db)} AS has_factor
      FROM members m
      LEFT JOIN local_credentials lc ON lc.tenant_id = m.tenant_id AND lc.member_sub = m.sub
      WHERE TRUE
        ${q ? req.db.sql`AND (m.display_name ILIKE ${'%' + q + '%'} OR m.email ILIKE ${'%' + q + '%'} OR m.sub ILIKE ${'%' + q + '%'})` : req.db.sql``}
        ${after ? req.db.sql`AND (m.created_at, m.sub) > (to_timestamp(${after.at}::numeric), ${after.sub})` : req.db.sql``}
      ORDER BY m.created_at, m.sub
      LIMIT ${limit + 1}`
    // one row past the limit answers "is there more" without a second count query
    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows
    const last = page[page.length - 1]
    // #949 review `identity_source` is who MINTED the identity, not whether removing a
    // password would leave this member locked out — a member can be born 'local' and since link a
    // provider, or born 'oidc' from a connection since deleted. The console's "remove password" item
    // reads THIS field, computed the same way the route below refuses the write.
    const anotherWayIn = await subsWithAnotherWayIn(req.db, req.tenant, page.map((m) => m.sub))
    return {
      members: page.map((m) => ({ ...m, has_another_way_in: anotherWayIn.has(m.sub) })),
      nextCursor: hasMore && last ? `${last.cursor_at}|${last.sub}` : null,
    }
  })

  // #579: the tenant-scope group name source. Assigning a tenant role to a GROUP needs the names the
  // members carry, and the only existing list was space-scoped and gated on that space's `manage` —
  // unusable from the admin console, where there is no space. Same projection, same sensitivity
  // argument (group names are not shown to every member), gated on tenant admin instead. Names only:
  // the id is derived server-side (group-sync.ts is the single id authority — a client that hashes
  // writes a tuple nobody holds, the #536 bug).
  // #623: the same query used to live here AND in spaces.ts. One function now — see listGroupNames.
  app.get<{ Querystring: { limit?: string; cursor?: string } }>('/admin/groups', async (req, reply) => {
    if (!(await requireTenantAdmin(req, reply))) return
    const limit = Number.parseInt(req.query.limit ?? '', 10)
    return listGroupNames(req.db, {
      ...(Number.isFinite(limit) ? { limit } : {}), ...(req.query.cursor ? { cursor: req.query.cursor } : {}),
    })
  })

  // #1054 / ADR-275 rev3 §4 (A8): the tenant-wide banner's own signal — any SIGNED-IN member may call
  // (not admin-only, deliberately: `last_admin` fires when the pending member IS the only administrator,
  // so an admin-gated notice would be unreachable in exactly the moment it would need to fire — the same
  // reasoning that put the out-of-band email on every member, #1051). A single boolean, never a count or
  // a sub or the floor: the same non-disclosure line the email and the list projection above both hold.
  app.get('/members/pending-notice', async (req) => {
    const [row] = await req.db.sql<{ any: boolean }[]>`
      SELECT EXISTS(SELECT 1 FROM members WHERE pending_scim_removal_at IS NOT NULL) AS any`
    return { pending: row?.any ?? false }
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
  app.patch<{ Params: { sub: string }; Body: { role?: string; confirm?: boolean } }>('/members/:sub', async (req, reply) => {
    if (!(await requireTenantAdmin(req, reply))) return
    const role = req.body?.role
    if (role !== 'admin' && role !== 'member') return reply.code(400).send({ error: 'invalid role' })

    const [existing] = await req.db.sql<[{ role: string; deactivated_at: Date | null }?]>`
      SELECT role, deactivated_at FROM members WHERE sub = ${req.params.sub}`
    if (!existing) return reply.code(404).send({ error: 'member not found' })
    // #627 ruling 2: refused while the member is suspended, at WRITE time. This handler does not read
    // `deactivated_at` otherwise, so a promotion wrote `tenant#admin` immediately — restoring a tuple the
    // suspension had removed and lighting up every relation that unions `or admin`, while `tenant#member`
    // stayed false. Deferring the question to reactivation instead would let a promotion written during a
    // suspension fire later with nobody watching; refusing costs nothing, since the change can be made
    // once they are back.
    if (existing.deactivated_at) {
      return reply.code(409).send({
        error: 'this member is suspended — bring them back before changing their role',
        code: 'member_suspended',
      })
    }
    if (existing.role === role) return { ok: true } // no-op

    if (existing.role === 'admin' && role === 'member') {
      // The floor first: "would this leave NO administrator". #866 / ADR-251 §3.7 adds the second
      // question underneath it, and the order matters — a tenant with one administrator gets the
      // floor's refusal, which is the one that names the right problem.
      if (await isLastAdmin(req.db.sql, req.params.sub)) {
        return reply.code(409).send(await lastAdminRefusal(req.db.sql))
      }
      // ⚠️ #866: the floor counts administrators, never key-holders — `auth/last-admin.ts` does not
      // join `local_credentials` at all. So with passwords the only door and two administrators, A
      // holding one and B holding none, demoting A passes the floor (B is still an administrator) and
      // lands on the state the ruling forbids: members can sign in, nobody can administer, and the
      // recovery is a command on the server. The same shape as the suspension beside it, one column
      // over — a key-holding administrator is made of TWO facts, and only one of them was guarded.
      // #925 / ADR-251 §3.8a: the SSO-exempt floor is asked FIRST — it is a narrower, WARNED question
      // ("is this the last exempt admin"), distinct from assertClosingIsSafe's ("is there any usable
      // way in at all"). Two confirm_requireds can fire on one write and they are not the same sentence.
      await assertNotLastExemptAdmin(req.db, req.tenant, req.params.sub, !!req.body?.confirm)
      await assertClosingIsSafe(req.db, req.tenant, { demoting: req.params.sub }, { confirm: req.body?.confirm })
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
    // #1053 / ADR-275 rev3 §3 fast-path: a promotion TO admin is one of the three trigger sites (a
    // demotion cannot resolve anything — it only ever narrows who can administer).
    if (role === 'admin') await reconcilePendingScimRemovalsIfRegistered({ db: req.db, fga: req.server.fga, valkey: req.server.valkey }, req.tenant)
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
  // #627 / ADR-213: SUSPEND and REACTIVATE, the operations a tenant without SCIM had no way to reach.
  // The verb is shared with the directory (auth/member-suspension.ts) — an admin's suspension differs
  // only in its reason, and the reason is what the ledger and the seat count read.
  app.post<{ Params: { sub: string }; Querystring: { confirm?: string } }>('/members/:sub/suspend', async (req, reply) => {
    if (!(await requireTenantAdmin(req, reply))) return
    // #627 setting 3: not yourself. An admin who suspends their own account signs themselves out of a
    // console they may be the only one holding — the last-admin guard below catches the worst case, but
    // this is the accident it cannot see (a tenant with two admins is not protected by it at all).
    if (req.params.sub === req.user.sub) {
      return reply.code(409).send({ error: 'you cannot suspend yourself', code: 'self_suspend' })
    }
    try {
      // #925 / ADR-251 §3.7/§3.8: suspendMember itself asks the exempt-floor and door-closing
      // questions now (before its transaction opens) — this is one of the three member routes with
      // no body, so `confirm` rides the query string, the same convention DELETE /members/:sub uses.
      const outcome = await suspendMember(
        { db: req.db, fga: app.fga, valkey: app.valkey }, req.tenant, req.params.sub,
        { reason: 'admin', actor: `user:${req.user.sub}`, confirm: req.query?.confirm === '1' },
      )
      if (outcome === 'notMember') return reply.code(404).send({ error: 'member not found' })
      return reply.code(200).send({ suspended: true, alreadySuspended: outcome === 'already' })
    } catch (err) {
      if (err instanceof LastAdminSuspensionError) {
        return reply.code(409).send({ error: err.message, code: err.code })
      }
      throw err
    }
  })

  app.post<{ Params: { sub: string } }>('/members/:sub/reactivate', async (req, reply) => {
    if (!(await requireTenantAdmin(req, reply))) return
    // #627 ruling 4: only an admin's own suspension. A member the DIRECTORY removed is not the console's
    // to restore — a tenant whose IdP dropped somebody could otherwise put them back, admin grant and
    // all, from inside the product. A billing freeze is cleared by re-upgrading, not from here.
    const r = await reactivateMember(
      { db: req.db, fga: app.fga, valkey: app.valkey }, req.tenant, req.params.sub,
      { allow: ['admin'], actor: `user:${req.user.sub}` },
    )
    if (r === 'notMember') return reply.code(404).send({ error: 'member not found' })
    if (r === 'notYours') {
      return reply.code(409).send({
        error: 'this member was not suspended from here — a directory removal is undone in the directory, and a plan freeze by upgrading',
        code: 'not_your_suspension',
      })
    }
    if (r === 'seatLimit') {
      return reply.code(409).send({ error: 'no seat is free for this member', code: 'seat_limit' })
    }
    return reply.code(200).send({ reactivated: true })
  })

  // #626 / ADR-214: the entrance an admin can GIVE, an admin can take back.
  //
  // Until this existed a password outlived every decision about it: removing somebody from the SSO-required
  // exemption list left their credential in place, and during a stance lapse (the IdP is down, so the
  // password door opens for everyone who has one — ADR-210 §2(d)) that person signs in although they are no
  // longer named. The exemption row was revoked; the key was not.
  //
  // NOT behind the tenant's password switch. Granting belongs there, but a tenant that has since turned
  // password sign-in off would otherwise be unable to clear the credentials it already handed out.
  app.delete<{ Params: { sub: string } }>('/members/:sub/password-setup', async (req, reply) => {
    if (!(await requireTenantAdmin(req, reply))) return
    const sub = req.params.sub
    const [member] = await req.db.sql<[{ sub: string }?]>`
      SELECT sub FROM members WHERE sub = ${sub}`
    if (!member) return reply.code(404).send({ error: 'member not found' })
    const [cred] = await req.db.sql<[{ member_sub: string }?]>`
      SELECT member_sub FROM local_credentials WHERE member_sub = ${sub}`
    if (!cred) return reply.code(404).send({ error: 'this member has no password entrance', code: 'no_password_entrance' })

    // (1) THIS PERSON's way in, not the tenant's — ADR-259 §3.9. `identity_source === 'local'` was a
    // PROXY for "this is their only door", and a link breaks the proxy in both directions: a `local`
    // member who has since linked a provider has two ways in and was refused for nothing (fixed here);
    // a member whose connection was deleted has none and was let through (also fixed — the mint-derived
    // check reads "still effective", not a static column). See `memberHasAnotherWayIn` for the two
    // things that count as another door once this credential is gone.
    if (!(await memberHasAnotherWayIn(req.db, req.tenant, sub))) {
      return reply.code(409).send({
        error: 'this is the only way this member can sign in — suspend them instead of removing their password',
        code: 'last_way_in',
      })
    }

    // (2) the SSO-required floor, guarded from the side it is not written on. The other guards read
    // the EXEMPTION rows (admin-login-methods.ts); this route removes the CREDENTIAL, so a tenant could be
    // left requiring SSO with an exemption that can no longer open anything — the outage case the floor
    // exists for. Same code, so a caller handles one refusal.
    //
    // #898: through `anAdminHoldsAKey`, which is what the ON precondition asks. This was its own
    // query and it did not read `role`, so the last exempt ADMINISTRATOR's password could be deleted
    // as long as any exempt ordinary member held one — leaving people who can sign in during an
    // outage and nobody among them who can fix it. The rule is written once now: #836 narrowed one
    // copy of three and left this one and the revoke loose, which is how a family ends up disagreeing.
    const [pref] = await req.db.sql<[{ sso_required: boolean }?]>`SELECT sso_required FROM tenant_login_prefs LIMIT 1`
    if (pref?.sso_required) {
      if (!(await anAdminHoldsAKey(req.db, { exemptOnly: true, without: sub }))) {
        return reply.code(409).send({
          error: SSO_FLOOR_REFUSAL.needAnExemptAdmin,
          code: 'sso_exemption_required',
        })
      }
    }

    await req.db.tx(async (tx) => {
      await tx`DELETE FROM local_credentials WHERE member_sub = ${sub}`
      // (3) and the tokens that would put it back. A setup token whose UPDATE matches no row INSERTS the
      // credential (password-reset.ts) — so a link minted in the last hour silently undoes this removal.
      await tx`DELETE FROM password_resets WHERE member_sub = ${sub}`
      // #654 / ADR-219 §7: and the second factors, which guarded the door being removed. Left behind
      // they would attach to whoever holds this `sub` next — the same reason the credential goes — and
      // in the meantime they would be an authenticator for a password that no longer exists.
      await tx`DELETE FROM member_factors WHERE member_sub = ${sub}`
      // #650 / ADR-226: the recovery set guarded the factors that just went. Left live it would be a
      // credential with nothing behind it — and the first factor the member enrols afterwards would be
      // wipeable by a code minted for a door that no longer exists.
      await tx`UPDATE member_recovery_codes SET revoked_at = now()
               WHERE member_sub = ${sub} AND used_at IS NULL AND revoked_at IS NULL`
      await auditIfEntitled(tx, req.tenant, {
        actor: `user:${req.user.sub}`, action: 'member.password_removed', target: `member:${sub}`,
      })
    })
    // (4) sessions are per MEMBER, so "the ones opened with the password" cannot be expressed. Removing a
    // credential is a security act rather than housekeeping (#474), so every session goes.
    await destroyMemberSessions(app.valkey, req.tenant.id, sub)
    emit({ type: 'member.password_removed', tenantId: req.tenant.id, actorId: req.user.sub, targetSub: sub })
    return reply.code(200).send({ removed: true })
  })

  /**
   * Clear a member's second factors so they can enrol again (#644 ruling 2 / ADR-219 §4).
   *
   * This is the ONLY way back for somebody who lost the device holding their factor, and it is the
   * shape ADR-210 §2(b) left standing: the administrator reset that borrows #626's PLACE and not its
   * mechanism. #626 mints a URL carrying a token, which is precisely the "time-boxed recovery URL"
   * §2(b) refused — a link that, minted for a second factor, would BE a way past the second factor.
   * So this route hands nothing out. It deletes rows, and the member proves who they are the ordinary
   * way and enrols again at the door (#652's interstitial exists for exactly the member who holds
   * nothing).
   *
   * CE, with no entitlement gate, per the same ruling: #626's reissue and take-away have none either,
   * and a deployment whose members can lock themselves out permanently is not "the same product without
   * the governance features".
   */
  app.delete<{ Params: { sub: string } }>('/members/:sub/factors', async (req, reply) => {
    if (!(await requireTenantAdmin(req, reply))) return
    const sub = req.params.sub
    const [member] = await req.db.sql<[{ sub: string }?]>`SELECT sub FROM members WHERE sub = ${sub}`
    if (!member) return reply.code(404).send({ error: 'member not found' })

    // NOT on yourself. `DELETE /me/factors/:id` asks for the factor's own code first (#660 / ADR-219
    // §8) — possession of the thing being given up. An admin who could aim this at themselves would
    // have a route that skips that proof, which makes the possession requirement optional for exactly
    // the accounts it matters most for. Somebody who has genuinely lost their device cannot sign in to
    // reach this anyway; another admin resets them.
    if (sub === req.user.sub) {
      return reply.code(409).send({
        error: 'remove your own factors from your account settings, where the factor is asked to prove itself',
        code: 'reset_self',
      })
    }

    let revokedCodes = 0
    const removed = await req.db.tx(async (tx) => {
      // The shared verb rather than the DELETE written out again: a member deletion, the password
      // take-away and this reset must clear the SAME set, and the two-copies failure is this
      // repository's standing lesson (#605's guard). The cast adapts a tx to the helper's `db.sql`
      // shape, as `email/outbox.ts:118` already does.
      const n = await deleteAllFactors({ sql: tx } as never, sub)
      // #650 / ADR-226 §5: and the recovery set, in the SAME transaction. A reset that left codes alive
      // would be a reset in name only — the printout in the drawer (which is why the reset was asked
      // for, if the drawer is not the member's any more) still wipes whatever factor they enrol next.
      revokedCodes = await revokeRecoveryCodes({ sql: tx } as never, sub)
      // Audited in the SAME transaction, and audited even when it removed nothing: "an admin aimed a
      // factor reset at this account" is the fact an investigation wants, and it is equally true of an
      // account that turned out to hold none.
      await auditIfEntitled(tx, req.tenant, {
        actor: `user:${req.user.sub}`, action: 'member.factors_reset', target: `member:${sub}`,
      })
      return n
    })
    // #474's house rule, which this repository applies to every credential removal: a live session was
    // opened by satisfying a factor that no longer exists, and leaving it up would let the old device —
    // if it is in somebody else's hands, which is why a reset was asked for — keep the account.
    await destroyMemberSessions(app.valkey, req.tenant.id, sub)
    emit({ type: 'member.factors_reset', tenantId: req.tenant.id, actorId: req.user.sub, targetSub: sub, count: removed, reason: 'admin' })
    // Only when there was something to revoke: an event saying a set was taken away from a member who
    // never had one is a line an investigator has to rule out by hand.
    if (revokedCodes > 0) {
      emit({
        type: 'member.recovery_codes_revoked', tenantId: req.tenant.id, actorId: req.user.sub,
        targetSub: sub, reason: 'admin_reset',
      })
    }
    return reply.code(200).send({ removed })
  })

  app.post<{ Params: { sub: string } }>('/members/:sub/password-setup', async (req, reply) => {
    if (!(await requireTenantAdmin(req, reply))) return
    // #1074 (ruled): the line is drawn between facts about the PERSON, which stay uniform, and facts
    // about the DEPLOYMENT, which are named. Having no address is the second kind — every member here
    // hits it identically, so it carries zero bits about the one the admin picked, and hiding it only
    // turns a settings mistake into a mystery about a colleague. The invite dialog one screen over has
    // always named it.
    //
    // THE DEPLOYMENT CHECK RUNS FIRST, and that ordering is the ruling's condition, not a tidiness
    // preference. Run the person check first and an address-less deployment answers `no address` for
    // the members who could otherwise be minted and the uniform sentence for the rest — and the
    // uniform sentence, appearing for some people and not others, is itself the disclosure the
    // uniformity exists to prevent. Checking the deployment first collapses everyone onto one answer
    // while the address is missing, so there is no difference left to read. Pinned behaviourally in
    // password-setup-deployment-first-1074.test.ts.
    //
    // It also means no token is minted for a link that cannot be built — the old order minted one and
    // then threw the response away, leaving a live reset token behind for an errand that never ran.
    const address = await tenantBaseUrl(req.db.sql, { id: req.tenant.id, slug: req.tenant.slug })
    if (!address.url) {
      req.log.warn({ tenantId: req.tenant.id, ranOut: address.ranOut }, `password setup: ${noAddressReason(address)}`)
      return reply.code(400).send({ error: 'this deployment has no address to build a link with', code: 'deployment_has_no_address' })
    }
    // The member lookup sits AFTER the deployment check, so "first" means first. The cost is that an
    // admin who mistypes a sub on an address-less deployment is told about the address before the
    // typo; they see the 404 once the address is set. Nothing is disclosed either way — a tenant admin
    // reads the member list — so this is ordering discipline, not a second disclosure rule.
    const [member] = await req.db.sql<[{ sub: string }?]>`SELECT sub FROM members WHERE sub = ${req.params.sub}`
    if (!member) return reply.code(404).send({ error: 'member not found' })
    const { mintPasswordSetup } = await import('../auth/password-reset.js')
    const minted = await mintPasswordSetup(req.db, req.params.sub)
    // One answer for the refusals that are facts about this MEMBER: they have no address of their own,
    // or their address is already somebody ELSE's sign-in name. Password sign-in being off for the
    // tenant also lands here for now — under #1074's line that is a configuration fact and nameable,
    // and the local-invite door already names it, but reconciling the two doors is its own ticket.
    //
    // #614 (review rejection): "they already have a password" is NOT among them any more. It used to be,
    // and that left the reset with one delivery route — email — for a product whose invite has always
    // had a copy-link fallback. An admin could not help somebody who had forgotten their password and
    // could not read mail, which is precisely #605's break-glass member.
    if (!minted) return reply.code(400).send({ error: 'this member cannot be given a password entrance', code: 'password_setup_unavailable' })
    const setupUrl = `${address.url}/reset-password?token=${minted.token}`
    // Two different events, because they are two different things to anyone reading the ledger later:
    // granting a password entrance changes who may authenticate this account; re-issuing a link for one
    // that already exists does not. The catalog already had the second (`member.password_reset_requested`
    // — the same act, initiated by the member) so no new event type is invented for it.
    const action = minted.reissue ? 'member.password_reset_requested' : 'member.password_enabled'
    await req.db.tx(async (tx) => auditIfEntitled(tx, req.tenant, {
      actor: `user:${req.user.sub}`, action, target: `member:${req.params.sub}`,
    })).catch((err: unknown) => req.log.warn({ err }, 'password-setup audit failed'))
    emit(minted.reissue
      ? { type: 'member.password_reset_requested', tenantId: req.tenant.id, actorId: req.user.sub, targetSub: req.params.sub }
      : { type: 'member.password_enabled', tenantId: req.tenant.id, actorId: req.user.sub, targetSub: req.params.sub })
    return reply.code(201).send({ setupUrl, email: minted.email, reissue: minted.reissue })
  })

  // Remove a member. ADR-003 ordering; then revoke ALL their live sessions so the
  // removal is immediate (not at TTL). Cannot remove the last admin.
  app.delete<{ Params: { sub: string }; Querystring: { confirm?: string } }>('/members/:sub', async (req, reply) => {
    if (!(await requireTenantAdmin(req, reply))) return
    const [existing] = await req.db.sql<[{ role: string; groups: string[] }?]>`
      SELECT role, groups FROM members WHERE sub = ${req.params.sub}`
    if (!existing) return reply.code(404).send({ error: 'member not found' })
    if (existing.role === 'admin' && (await isLastAdmin(req.db.sql, req.params.sub))) {
      return reply.code(409).send(await lastAdminRefusal(req.db.sql))
    }
    // #925 / ADR-251 §3.8 / §3.8a: this write takes the key away the same as a demotion or a
    // suspension, and a removal can close the last way in exactly like the other two — the floor
    // question first (warned), then the general "is there any usable way in left" question.
    if (existing.role === 'admin') {
      const confirmed = req.query?.confirm === '1'
      await assertNotLastExemptAdmin(req.db, req.tenant, req.params.sub, confirmed)
      await assertClosingIsSafe(req.db, req.tenant, { deactivating: req.params.sub }, { confirm: confirmed })
    }

    let revokedKeyIds: string[] = []
    // #896: filled inside the tx, used after commit. Declared out here because Decision 5's ordering
    // puts the enqueue and the store call on opposite sides of the transaction boundary.
    let groupIntents: TupleIntent[] = []
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
      // #654 / ADR-219 §7. The composite FK cascades this in the logical schema — written out for the
      // same reason `password_resets` is one line up: a namespaced tenant does not replicate it, and a
      // deletion that depends on which isolation strategy a tenant happens to be on is one that works
      // until somebody is promoted.
      await tx`DELETE FROM member_factors WHERE member_sub = ${req.params.sub}`
      // #650 / ADR-226. DELETED rather than revoked, unlike everywhere else this set is taken out of
      // service: the member is GONE, so there is no history to keep for them, and a row keyed by a bare
      // `member_sub` would attach to whoever holds this subject next — the same reason the factors and
      // the password go out explicitly one line up rather than being left to a cascade.
      await tx`DELETE FROM member_recovery_codes WHERE member_sub = ${req.params.sub}`
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
      // the login tx rolls back → permanent login failure.
      //
      // #896 / ADR-255 Decision 5: the store call has LEFT this transaction, so #378's swallow has
      // nothing left to swallow here. The intent is written down instead — enqueue in-tx, delete
      // after commit, success drops the row. Recording only what a catch saw would lose the crash
      // between commit and call, which is the one case a catch block cannot observe. #378's rule is
      // unchanged and now holds for a reason rather than by forgetting: drift can neither block the
      // removal nor survive it, because the queue outlives the request that could not finish.
      groupIntents = (existing.groups ?? []).map((g) => ({
        subject: `user:${req.params.sub}`,
        relation: 'member',
        object: `group:${groupFgaId(req.tenant.id, g)}`,
      }))
      await enqueueTupleDeletes(tx, req.tenant.id, groupIntents)
      // Durable compliance audit (#177), in-tx + EE-gated.
      await auditIfEntitled(tx, req.tenant, { actor: `user:${req.user.sub}`, action: 'member.removed', target: `user:${req.params.sub}` })
      for (const k of revoked) {
        await auditIfEntitled(tx, req.tenant, { actor: `user:${req.user.sub}`, action: 'api_key.revoked', target: `api_key:${k.id}` })
      }
      revokedKeyIds = revoked.map((k) => k.id)
    })
    // #896: after commit, per Decision 5's ordering. Never throws — a failure here leaves the queue
    // row for the drain, which is the whole point of having written it.
    await flushTupleDeletes(req.server.fga, req.tenant.id, groupIntents)
    await destroyMemberSessions(req.server.valkey, req.tenant.id, req.params.sub)
    // #396: post-commit residual sweep — the removed sub's direct space/page grants (this tenant only)
    // + the synchronous search reindex. Failures are logged per-tuple, never block the removal.
    await sweepMemberDirectGrants(req.db, req.server.fga, req.server.searchDriver, { tenantId: req.tenant.id, sub: req.params.sub })
    for (const keyId of revokedKeyIds) emit({ type: 'api_key.revoked', tenantId: req.tenant.id, keyId, actorId: req.user.sub })
    emit({ type: 'member.removed', tenantId: req.tenant.id, actorId: req.user.sub, targetSub: req.params.sub })
    return reply.code(204).send()
  })

  // #688 slice 2: the DSAR erase and the tenant roll-up (GET /admin/analytics) moved with the
  // analytics feature into @wikistead-ee/server — analyticsEeMount registers them via the seam.

  // ── Invites ──────────────────────────────────────────────────────────────
  // #623 — see the block inside the handler.
  //
  // ⚠️ The explanation lives INSIDE the handler, and that is not a style choice: prose written above a
  // registration falls inside the PREVIOUS route's window, and the ledger scan reads that window for
  // bound keywords. Written above this line, the word describing the paging mechanism made
  // `GET /admin/analytics` read as bounded — a route two hundred lines away, with a real debt line.
  app.get<{ Querystring: { limit?: string; cursor?: string } }>('/members/invites', async (req, reply) => {
    // One row per pending invitation, and #638 boxed the UI without touching the payload — a tenant
    // that has been inviting for a year sent all of them on every open of the members screen.
    //
    // The position marker carries an epoch rather than a formatted timestamp: a parameter loses its
    // microseconds on the way in. This walk is DESC — the direction that SKIPS — so an invitation
    // issued between the truncated instant and the true one would appear on no page, and an invitation
    // nobody can see is one nobody can revoke or re-issue. `id` breaks ties: a bulk invite stamps
    // several in the same instant.
    if (!(await requireTenantAdmin(req, reply))) return
    const asked = Number.parseInt(req.query.limit ?? '', 10)
    const limit = Math.min(500, Math.max(1, Number.isFinite(asked) ? asked : INVITES_PAGE_LIMIT))
    const bar = req.query.cursor?.indexOf('|') ?? -1
    const after = req.query.cursor && bar > 0
      ? { at: req.query.cursor.slice(0, bar), id: req.query.cursor.slice(bar + 1) } : null
    const rows = await req.db.sql<
      { id: string; email: string | null; role: string; invited_by: string; expires_at: Date; created_at: Date; last_emailed_at: Date | null; cursor_at: string }[]
    >`SELECT id, email, role, invited_by, expires_at, created_at, last_emailed_at,
             extract(epoch from created_at)::text AS cursor_at
        FROM invites WHERE status = 'pending' AND expires_at > now()
          ${after ? req.db.sql`AND (created_at, id) < (to_timestamp(${after.at}::numeric), ${after.id})` : req.db.sql``}
        ORDER BY created_at DESC, id DESC
        LIMIT ${limit + 1}`
    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows
    const last = page[page.length - 1]
    return {
      invites: page.map(({ cursor_at: _drop, ...r }) => r),
      nextCursor: hasMore && last ? `${last.cursor_at}|${last.id}` : null,
    }
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

    // #1056 / ADR-254 addendum: built from the deployment's declared address, never the request's
    // Host header (the same Host-spoofing hole #1008 escaped but did not close). Unlike reset-request
    // this is a synchronous, admin-authenticated create — there is no uniform-silence contract to
    // preserve — so an unaddressable deployment is reported explicitly: the invite row and token still
    // exist (createInvite above already committed), only the link is missing until an operator sets
    // WKS_PUBLIC_BASE_URL or a custom domain, after which `reissue` mints a working one.
    const address = await tenantBaseUrl(req.db.sql, { id: req.tenant.id, slug: req.tenant.slug })
    const inviteUrl = address.url ? `${address.url}/invite?token=${token}` : null
    if (!address.url) req.log.warn({ tenantId: req.tenant.id, ranOut: address.ranOut }, `invite create: ${noAddressReason(address)}`)

    let emailed = false
    if (email && inviteUrl) {
      try {
        // #1008 / ADR-260 §6.3: an invite target has no member row yet, so the chain can only ever
        // reach its second step — the tenant default, never a member locale (there is no member).
        const lang = resolveMailLocale(null, await tenantDefaultLang(req.db))
        // #547 / ADR-196 §7: the REQUEST path resolves per tenant too — a resolver consulted only by
        // the outbox drain would silently drop a managed-sender tenant's invite mail onto the CE
        // fallback (rev2/N-a). The boot-time app.email stays the fallback.
        const { resolveTenantEmailDriver } = await import('@wikistead/hooks')
        await resolveTenantEmailDriver({ tenantId: req.tenant.id, plan: req.tenant.plan }, req.server.email).send({
          to: email,
          subject: inviteSubject(lang, req.tenant.slug, productName()),
          text: inviteBodyText(lang, req.tenant.slug, productName(), inviteUrl),
          // §3.3a: the sentence is a text entry; this site writes the <strong> and the anchor.
          html: `<p>${inviteSentence(lang, `<strong>${esc(req.tenant.slug)}</strong>`, esc(productName()))}</p>`
            + `<p><a href="${esc(inviteUrl)}">${esc(inviteAcceptLabel(lang))}</a></p>`,
        })
        emailed = true
        // #638: the outcome used to be reported once, in this response, and then forgotten — the list of
        // pending invites could not say which of its rows anybody had actually received.
        await req.db.sql`UPDATE invites SET last_emailed_at = now() WHERE token_hash = ${hashInviteToken(token)}`
      } catch (err) {
        req.log.warn({ err }, 'invite email send failed — link still valid')
      }
    }
    emit({ type: 'invite.created', tenantId: req.tenant.id, actorId: req.user.sub, role })
    return reply.code(201).send({ inviteUrl, emailed, seatWarning })
  })

  // #638 (user ruling): hand a pending invitation over again.
  //
  // The asymmetry this closes: a password entrance could always be re-issued (#626), while an invite had
  // neither a resend nor a way to read its link back — and it is the invite that strands people, because
  // a tenant with no mail configured has only the link that appeared once on the screen that made it.
  // The recovery was to revoke and invite again, which is a different invitation to anyone reading the
  // ledger and a second chance to get the address wrong.
  //
  // One act, two deliveries. `email: true` sends the new link and also returns it, because sending is
  // best-effort here as it is everywhere else: an admin whose mail silently fails still needs the copy in
  // their hand. Both paths invalidate the old link — that is not a choice, the token is hashed at rest —
  // and the response says so through `previousLinkRevoked` rather than leaving the screen to assume.
  app.post<{ Params: { id: string }; Body: { email?: boolean } }>('/members/invites/:id/reissue', async (req, reply) => {
    if (!(await requireTenantAdmin(req, reply))) return
    const reissued = await reissueInvite(req.db, req.params.id)
    if (!reissued) return reply.code(404).send({ error: 'invite not found or not pending' })

    // #1056 / ADR-254 addendum: same reasoning as the create path — the deployment's declared address,
    // never the request's Host header.
    const address = await tenantBaseUrl(req.db.sql, { id: req.tenant.id, slug: req.tenant.slug })
    const inviteUrl = address.url ? `${address.url}/invite?token=${reissued.token}` : null
    if (!address.url) req.log.warn({ tenantId: req.tenant.id, ranOut: address.ranOut }, `invite reissue: ${noAddressReason(address)}`)

    let emailed = false
    if (req.body?.email === true && reissued.email && inviteUrl) {
      try {
        // #1008 / ADR-260 §6.3: same reasoning as the create path — no member row exists yet.
        const lang = resolveMailLocale(null, await tenantDefaultLang(req.db))
        const { resolveTenantEmailDriver } = await import('@wikistead/hooks')
        await resolveTenantEmailDriver({ tenantId: req.tenant.id, plan: req.tenant.plan }, req.server.email).send({
          to: reissued.email,
          subject: inviteSubject(lang, req.tenant.slug, productName()),
          text: inviteBodyText(lang, req.tenant.slug, productName(), inviteUrl),
          // §3.3a: the sentence is a text entry; this site writes the <strong> and the anchor.
          html: `<p>${inviteSentence(lang, `<strong>${esc(req.tenant.slug)}</strong>`, esc(productName()))}</p>`
            + `<p><a href="${esc(inviteUrl)}">${esc(inviteAcceptLabel(lang))}</a></p>`,
        })
        emailed = true
        await req.db.sql`UPDATE invites SET last_emailed_at = now() WHERE id = ${req.params.id}`
      } catch (err) {
        req.log.warn({ err }, 'invite re-send failed — the new link is still valid')
      }
    }
    // The ledger keeps this apart from `invite.created`: no new invitation exists, and no seat moved.
    // Reading a re-issue as a creation would make a tenant look like it invited the same person twice.
    await req.db.tx(async (tx) => auditIfEntitled(tx, req.tenant, {
      actor: `user:${req.user.sub}`, action: 'invite.reissued', target: `invite:${req.params.id}`,
    })).catch((err: unknown) => req.log.warn({ err }, 'invite reissue audit failed'))
    emit({ type: 'invite.reissued', tenantId: req.tenant.id, actorId: req.user.sub, emailed })
    return reply.code(200).send({ inviteUrl, emailed, previousLinkRevoked: true, expiresAt: reissued.expiresAt })
  })

  app.delete<{ Params: { id: string } }>('/members/invites/:id', async (req, reply) => {
    if (!(await requireTenantAdmin(req, reply))) return
    const ok = await revokeInvite(req.db, req.params.id)
    if (!ok) return reply.code(404).send({ error: 'invite not found or not pending' })
    emit({ type: 'invite.revoked', tenantId: req.tenant.id, actorId: req.user.sub })
    return reply.code(204).send()
  })
}
