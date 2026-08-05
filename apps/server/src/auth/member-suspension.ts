import type { OpenFgaClient } from '@openfga/sdk'
import { writeTuples, deleteTuples } from '@wikistead/authz'
import { resolveEntitlements } from '@wikistead/entitlements'
import { emit } from '@wikistead/events'
import type IORedis from 'ioredis'
import type { TenantDb } from '../db/index.js'
import { billableMemberCount, lockSeats } from './invites.js'
import { syncMemberGroups } from './group-sync.js'
import { isLastAdmin } from './last-admin.js'
import { destroyMemberSessions } from './session.js'
import { auditIfEntitled } from '../audit/outbox.js'

// #627 / ADR-213: SUSPENDING A MEMBER — one verb, in CE, for every caller.
//
// The behaviour already existed and was complete: block sign-in, strip `tenant#member` (+`admin`) and
// every `group#member`, revoke the API keys (#475), destroy the sessions (#477), free nothing that
// cannot be given back (the row and `external_id` stay so the person can return), and refuse to remove
// the last admin (#573). What did not exist was a way for an ADMIN to reach it: the only callers were
// SCIM (EE only) and the billing reconcile. A tenant without SCIM — every CE tenant, and any EE tenant
// that never wired an IdP — could only DELETE somebody, losing their seat, their history and any way
// back, for what should have been the lighter act.
//
// So the verb moves here and SCIM calls it. No new meaning of "suspended" is invented; the reason is a
// parameter, because the reason is the only thing that differed.
export type SuspensionReason = 'scim' | 'admin'

/**
 * WHOSE suspension is this, and may the caller undo it?
 *
 * Two predicates, deliberately NOT one — a single shared "is this deactivated" question was written
 * during review and refused twice, because the two sites want opposite answers when a reason nobody has
 * seen before turns up:
 *
 *   `fga:resync` REBUILDS grants, so it needs an ALLOWLIST: rebuild for reasons known to keep their
 *   tuples, and for an unknown reason rebuild nothing (a member stays stripped — safe);
 *   the SCIM idempotency check REFUSES work, so it needs a DENYLIST: "already done, nothing to do" may
 *   only be said for reasons SCIM itself owns, or an unknown reason is answered "already suspended"
 *   while the grants are still live (unsafe).
 *
 * Sharing one predicate makes one of the two fail open on the day a third reason is added.
 */
// A `downgrade_freeze` row KEEPS its tuples — plan-reconcile never touches FGA (#131) — so a resync
// must put them back. Suspensions strip theirs on purpose and must stay stripped.
const REASONS_THAT_KEEP_GRANTS = new Set(['downgrade_freeze'])
export const grantsShouldBeRebuilt = (deactivatedAt: unknown, reason: string | null): boolean =>
  !deactivatedAt || REASONS_THAT_KEEP_GRANTS.has(reason ?? '')

/** Only SCIM's own suspension is SCIM's to consider already done. */
export const isScimSuspension = (reason: string | null): boolean => reason === 'scim'

interface MemberState {
  role: string
  groups: string[] | null
  deactivated_at: Date | null
  deactivation_reason: string | null
}

export class LastAdminSuspensionError extends Error {
  statusCode = 409
  code = 'last_admin'
  constructor() { super('the last admin cannot be suspended — promote somebody else first') }
}

export type SuspendOutcome = 'changed' | 'already' | 'notMember'

/**
 * Suspend a member. `actor` names who is doing it, for the ledger; `reason` is what the row records.
 *
 * #627 ruling 5: a member frozen by a plan downgrade CAN be suspended by an admin — the reason is
 * rewritten to `'admin'`, which is the honest record that a human decision replaced a billing state.
 * Ruling 1 keeps such a member billable (the seat is held, not freed): `billableMemberCount` excludes
 * only `reason='scim'`, and that condition is deliberately untouched here.
 */
export async function suspendMember(
  deps: { db: TenantDb; fga: OpenFgaClient; valkey?: IORedis },
  tenant: { id: string; plan: string },
  sub: string,
  opts: { reason: SuspensionReason; actor: string },
): Promise<SuspendOutcome> {
  let revoked: string[] = []
  const outcome = await deps.db.tx(async (tx): Promise<SuspendOutcome> => {
    // #573 re-review NEW-2: reading inside the tx is not serialization. Two concurrent suspensions of
    // the last two admins each saw the other still active and both went through (measured). The same
    // per-tenant advisory lock the seat decisions take answers the last-admin question one at a time.
    await lockSeats(tx, tenant.id)
    const [m] = await tx<MemberState[]>`
      SELECT role, groups, deactivated_at, deactivation_reason FROM members WHERE sub = ${sub}`
    if (!m) return 'notMember'
    // Idempotent only for a suspension of the SAME kind. A frozen member is not "already suspended" to
    // an admin (ruling 5), and a SCIM repeat must not claim to have handled an admin's decision.
    if (m.deactivated_at && m.deactivation_reason === opts.reason) return 'already'
    if (opts.reason === 'scim' && m.deactivated_at && !isScimSuspension(m.deactivation_reason)) return 'already'
    if (m.role === 'admin' && (await isLastAdmin(tx, sub))) throw new LastAdminSuspensionError()

    const prevGroups = m.groups ?? []
    await tx`UPDATE members SET deactivated_at = now(), deactivation_reason = ${opts.reason},
             groups = ${deps.db.sql.array([])}, updated_at = now() WHERE sub = ${sub}`
    // #475: the keys go with the suspension. `verifyApiKey` reads only `revoked_at` — not
    // `deactivated_at`, not membership — so an un-revoked key kept authenticating a suspended sub.
    // Revoked rather than deleted (the rows stay auditable) and NOT restored on return.
    const revokedKeys = await tx<{ id: string }[]>`
      UPDATE api_keys SET revoked_at = now() WHERE owner_user_id = ${sub} AND revoked_at IS NULL RETURNING id`
    // FGA last, so a failure rolls the whole thing back.
    await syncMemberGroups(deps.fga, tenant.id, sub, prevGroups, [])
    const tuples = [{ user: `user:${sub}`, relation: 'member', object: `tenant:${tenant.id}` }]
    if (m.role === 'admin') tuples.push({ user: `user:${sub}`, relation: 'admin', object: `tenant:${tenant.id}` })
    await deleteTuples(deps.fga, tuples)
    await auditIfEntitled(tx, tenant, {
      actor: opts.actor,
      action: opts.reason === 'scim' ? 'member.removed' : 'member.suspended',
      target: `user:${sub}`,
    })
    for (const k of revokedKeys) {
      await auditIfEntitled(tx, tenant, { actor: opts.actor, action: 'api_key.revoked', target: `api_key:${k.id}` })
    }
    revoked = revokedKeys.map((k) => k.id)
    return 'changed'
  })
  // #480: effects AFTER the commit. Emitted inside, a later failure rolls the revocation back while
  // subscribers have already been told the member is gone — an error in the dangerous direction.
  if (outcome === 'changed') {
    emit(opts.reason === 'scim'
      ? { type: 'member.removed', tenantId: tenant.id, actorId: opts.actor, targetSub: sub }
      : { type: 'member.suspended', tenantId: tenant.id, actorId: opts.actor, targetSub: sub })
    for (const id of revoked) emit({ type: 'api_key.revoked', tenantId: tenant.id, keyId: id, actorId: opts.actor })
    if (deps.valkey) await destroyMemberSessions(deps.valkey, tenant.id, sub)
  }
  return outcome
}

export type ReactivateOutcome = 'ok' | 'notMember' | 'notYours' | 'seatLimit'

/**
 * Bring a suspended member back.
 *
 * `allow` is which reasons this caller may undo. SCIM passes `['scim']`: a `downgrade_freeze` belongs to
 * billing (cleared by re-upgrading) and an `'admin'` suspension belongs to the console. An admin passes
 * `['admin']` — ruling 4: a member SCIM removed is not the console's to restore, because a tenant whose
 * IdP dropped somebody could otherwise put them back, admin grant and all, from inside the product.
 *
 * `groups` stay cleared (ruling 3). The IdP re-adds them on the next sign-in; for a member with no IdP
 * they do not come back at all, which is why the UI has to SAY so rather than let it be discovered.
 */
export async function reactivateMember(
  deps: { db: TenantDb; fga: OpenFgaClient },
  tenant: { id: string; plan: string },
  sub: string,
  opts: { allow: readonly SuspensionReason[]; actor: string },
): Promise<ReactivateOutcome> {
  let restoredRole: string | null = null
  const result = await deps.db.tx(async (tx): Promise<ReactivateOutcome> => {
    await lockSeats(tx, tenant.id)
    const [m] = await tx<MemberState[]>`
      SELECT role, groups, deactivated_at, deactivation_reason FROM members WHERE sub = ${sub}`
    if (!m) return 'notMember'
    if (!m.deactivated_at) return 'ok' // already active (idempotent)
    if (!opts.allow.includes((m.deactivation_reason ?? '') as SuspensionReason)) return 'notYours'
    // returning re-counts the seat, so the cap is re-enforced under the same lock
    const ent = resolveEntitlements(tenant.plan)
    if (isFinite(ent.maxSeats) && (await billableMemberCount(tx)) >= ent.maxSeats) return 'seatLimit'
    await tx`UPDATE members SET deactivated_at = NULL, deactivation_reason = NULL, updated_at = now() WHERE sub = ${sub}`
    const tuples = [{ user: `user:${sub}`, relation: 'member', object: `tenant:${tenant.id}` }]
    if (m.role === 'admin') tuples.push({ user: `user:${sub}`, relation: 'admin', object: `tenant:${tenant.id}` })
    await writeTuples(deps.fga, tuples)
    restoredRole = m.role
    await auditIfEntitled(tx, tenant, {
      actor: opts.actor,
      action: opts.actor === 'scim' ? 'member.added' : 'member.reactivated',
      target: `user:${sub}`,
    })
    return 'ok'
  })
  if (result === 'ok' && restoredRole) {
    emit(opts.actor === 'scim'
      ? { type: 'member.added', tenantId: tenant.id, targetSub: sub, role: restoredRole, via: 'provision' }
      : { type: 'member.reactivated', tenantId: tenant.id, actorId: opts.actor, targetSub: sub })
  }
  return result
}
