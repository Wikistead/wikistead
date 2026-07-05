// Tenant invites (P1.4). The third membership-grant path — the open-ended,
// fully-normal one (after Cloud signup's provisionTenant and the bounded CE
// bootstrapFirstAdmin). All three share ADR-003: DB writes first, FGA last, throw
// → full rollback, so a member never exists in DB without its FGA grant (or vice
// versa).
//
// Token discipline mirrors the other short-lived secrets in this codebase (guest
// token / signup session / OIDC state): random 256-bit, plaintext ONLY in the
// emailed link, SHA-256 hash at rest (like API keys), tenant-bound, role-bound,
// short-lived, consume-once, admin-revocable.
import { createHash, randomBytes } from 'node:crypto'
import type { Sql } from 'postgres'
import type { OpenFgaClient } from '@openfga/sdk'
import { writeTuples } from '@wikistead/authz'
import { resolveEntitlements } from '@wikistead/entitlements'
import { emit } from '@wikistead/events'
import type { TenantDb } from '../db/index.js'

// Placeholder TTL (pre-launch; env-configurable later, like the session TTLs).
const INVITE_TTL_MS = 7 * 24 * 3600 * 1000

export type InviteRole = 'admin' | 'member'

function generateToken(): string {
  return `inv_${randomBytes(32).toString('base64url')}`
}

// Exported so the accept path (which receives the plaintext token from the link)
// can look the row up by the same hash the create path stored.
export function hashInviteToken(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex')
}

function memberTuples(tenantId: string, sub: string, role: InviteRole) {
  const tuples = [{ user: `user:${sub}`, relation: 'member', object: `tenant:${tenantId}` }]
  if (role === 'admin') tuples.push({ user: `user:${sub}`, relation: 'admin', object: `tenant:${tenantId}` })
  return tuples
}

// THE single source of truth for billable seat count (ADR-004 / ADR-034). A billable
// seat == one member row. Guests are NEVER counted: they hold a short-lived share_link
// principal (FGA), never a `members` row, so they are excluded structurally — there is
// no guest discriminator to filter. Seat release is immediate: removing a member deletes
// the row, so the count drops at once (no logical-delete residue). Whether a
// suspended/deactivated member stays billable, and whether release is immediate vs.
// end-of-period, are BUSINESS-NUMBER questions (ADR-031); the mechanism counts live
// member rows and can be refined to a `billable` predicate here without touching callers.
export async function billableMemberCount(sql: Sql): Promise<number> {
  // A SCIM-deprovisioned member (deactivation_reason='scim', #134) RELEASES its seat — excluded
  // here. A #131 downgrade-freeze member (reason='downgrade_freeze') stays billable (still counted)
  // — it is the result of being over-cap, restored on re-upgrade. Active members (reason NULL) count.
  const [{ n }] = await sql<[{ n: string }]>`
    SELECT count(*)::text AS n FROM members WHERE deactivation_reason IS DISTINCT FROM 'scim'`
  return Number(n)
}

// Whether `sub` is ALREADY a member of this tenant. An existing member re-accepting an
// invite (re-invite, or a second link) must be idempotent: no new seat, no error — they
// already hold their one seat (dedupe by user identity).
async function isMember(sql: Sql, sub: string): Promise<boolean> {
  const rows = await sql<{ one: number }[]>`SELECT 1 AS one FROM members WHERE sub = ${sub} LIMIT 1`
  return rows.length > 0
}

// Seats reserved for the issue-time WARNING = billable members + pending, non-expired
// invites. Issue is NOT blocked (accept is the fortress); this only drives a warning so
// an admin knows they are over-issuing. (A pending invite reserves a seat optimistically.)
async function seatsReservable(sql: Sql): Promise<number> {
  const pending = await sql<[{ n: string }]>`
    SELECT count(*)::text AS n FROM invites WHERE status = 'pending' AND expires_at > now()
  `
  return (await billableMemberCount(sql)) + Number(pending[0]!.n)
}

// Per-tenant serialization for the accept seat check. pg_advisory_xact_lock is held to
// end-of-transaction, so concurrent accepts for the SAME tenant run one at a time —
// turning count→compare→insert into an atomic decision (no "remaining=1, two accept,
// both succeed" race). Mirrors provisioning.ts's bootstrap lock.
export async function lockSeats(sql: Sql, tenantId: string): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtext(${'seats:' + tenantId})::bigint)`
}

// Create an invite. Authorization (tenant admin) is enforced at the route. Issuing is the
// CONVENIENCE layer, not the fortress (ADR-034): it does NOT hard-block at the seat cap —
// a seat may free up before the invite is accepted, and accept is where the cap is truly
// enforced. Instead it returns `seatWarning` so the admin sees they are over-issuing. The
// SEAT CAP itself (the primary paid lever) is enforced atomically in acceptInvite.
// UNLIMITED (self-host) has maxSeats = Infinity → never warns = Community First. Returns
// the PLAINTEXT token so the caller can build the link + email it; only the hash persists.
export async function createInvite(
  db: TenantDb,
  args: { tenantId: string; plan: string; invitedBy: string; email: string | null; role: InviteRole },
): Promise<{ id: string; token: string; expiresAt: Date; seatWarning: boolean }> {
  const ent = resolveEntitlements(args.plan)
  const seatWarning = isFinite(ent.maxSeats) && (await seatsReservable(db.sql)) >= ent.maxSeats
  const token = generateToken()
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS)
  const [row] = await db.sql<[{ id: string }]>`
    INSERT INTO invites (tenant_id, token_hash, email, role, invited_by, expires_at)
    VALUES (${args.tenantId}, ${hashInviteToken(token)}, ${args.email}, ${args.role}, ${args.invitedBy}, ${expiresAt})
    RETURNING id
  `
  return { id: row.id, token, expiresAt, seatWarning }
}

// Accept an invite: turn a verified-but-not-yet-member identity into a member.
// Returns true if THIS call granted (or idempotently confirmed) membership; false if the
// token is unknown, expired, already consumed, revoked, or belongs to another tenant (all
// indistinguishable to the caller). Throws (statusCode 402, code 'seat_limit') ONLY when a
// NEW seat would exceed the cap, so a full tenant is surfaced distinctly from a bad invite.
//
// THE FORTRESS (ADR-034): accept is where the seat cap is enforced, atomically.
//  - pg_advisory_xact_lock(seats:<tenant>) serializes concurrent accepts per tenant, so the
//    count→compare→insert is one indivisible decision (remaining=1 + two accepts ⇒ one 402).
//  - Idempotent by user identity: an existing member re-accepting consumes NO new seat and
//    does not error (ON CONFLICT DO NOTHING; the seat check is skipped for them). A second
//    link for the same person therefore costs one seat, not two.
//  - 402 (not 403): the cap is a billing limit. A bad/expired token is a separate concern
//    (returns false → the route answers uniformly, leaking nothing about token existence).
//
// ADR-003: the invite flip + member INSERT happen in one tx; FGA is written LAST, so a FGA
// failure rolls back the accept and the member row (no half member).
export async function acceptInvite(
  deps: { db: TenantDb; fga: OpenFgaClient },
  tenant: { id: string; plan: string },
  token: string,
  claims: { sub: string; email?: string | null; name?: string | null },
): Promise<boolean> {
  return deps.db.tx(async (tx) => {
    // Serialize seat decisions for this tenant for the rest of the tx (atomic cap check).
    await lockSeats(tx, tenant.id)

    // Consume-once: only a pending, non-expired invite for THIS tenant wins, and
    // exactly one concurrent caller can flip it (single UPDATE ... RETURNING).
    const flipped = await tx<{ role: InviteRole }[]>`
      UPDATE invites
         SET status = 'accepted', accepted_sub = ${claims.sub}, accepted_at = now()
       WHERE token_hash = ${hashInviteToken(token)}
         AND tenant_id  = ${tenant.id}
         AND status     = 'pending'
         AND expires_at > now()
      RETURNING role
    `
    if (flipped.length === 0) return false // unknown / expired / consumed / revoked / cross-tenant
    // The seat fortress (lock already held above): idempotent for an existing member, cap-checked,
    // atomic member INSERT + FGA. Shared with #101 auto-enrolment so EVERY new-member path goes through
    // the ONE gate. Returns whether it created; acceptInvite answers true either way (membership held).
    await enrolUnderSeatCap(tx, deps.fga, tenant, claims, flipped[0]!.role, 'invite')
    return true
  })
}

// THE SEAT FORTRESS (ADR-034), shared by invite accept AND #101 auto-enrolment. The caller MUST already
// hold lockSeats(tx, tenant.id) so the count→compare→insert is one indivisible decision (this re-acquires
// it harmlessly — advisory locks are re-entrant within a tx). Idempotent by identity (an existing member
// consumes no seat, no DB/FGA change, no error). Throws 402 seat_limit for a NEW member over the cap →
// the whole tx rolls back. FGA is written LAST (ADR-003). Returns 'created' | 'exists'.
export async function enrolUnderSeatCap(
  tx: Sql,
  fga: OpenFgaClient,
  tenant: { id: string; plan: string },
  claims: { sub: string; email?: string | null; name?: string | null },
  role: InviteRole,
  via: 'invite' | 'auto',
): Promise<'created' | 'exists'> {
  await lockSeats(tx, tenant.id)
  if (await isMember(tx, claims.sub)) return 'exists'
  const ent = resolveEntitlements(tenant.plan)
  if (isFinite(ent.maxSeats) && (await billableMemberCount(tx)) >= ent.maxSeats) {
    throw Object.assign(new Error('seat limit reached'), { statusCode: 402, code: 'seat_limit' })
  }
  await tx`
    INSERT INTO members (tenant_id, sub, email, display_name, role)
    VALUES (${tenant.id}, ${claims.sub}, ${claims.email ?? null}, ${claims.name ?? null}, ${role})
    ON CONFLICT (tenant_id, sub) DO NOTHING
  `
  await writeTuples(fga, memberTuples(tenant.id, claims.sub, role))
  emit({ type: 'member.added', tenantId: tenant.id, targetSub: claims.sub, role, via })
  return 'created'
}

// Revoke a pending invite (admin action). Returns true if a pending invite was
// revoked; false if it was already accepted/revoked or does not exist.
export async function revokeInvite(db: TenantDb, inviteId: string): Promise<boolean> {
  const rows = await db.sql<{ id: string }[]>`
    UPDATE invites SET status = 'revoked'
     WHERE id = ${inviteId} AND status = 'pending'
    RETURNING id
  `
  return rows.length > 0
}
