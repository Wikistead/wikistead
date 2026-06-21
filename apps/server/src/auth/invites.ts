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

// Seats in use for the CREATE check = current members + pending, non-expired
// invites. Pending invites are treated as reserved seats so an admin cannot issue
// more invites than seats (e.g. 100 invites on a 5-seat plan, all accepted later).
async function seatsReservable(sql: Sql): Promise<number> {
  const [{ n }] = await sql<[{ n: string }]>`
    SELECT (
      (SELECT count(*) FROM members)
      + (SELECT count(*) FROM invites WHERE status = 'pending' AND expires_at > now())
    )::text AS n
  `
  return Number(n)
}

// Seats actually consumed for the ACCEPT check = current members only (a pending
// invite about to be accepted has not become a seat yet; revoked/expired ones
// freed theirs). Defence in depth alongside the create-time check.
async function seatsConsumed(sql: Sql): Promise<number> {
  const [{ n }] = await sql<[{ n: string }]>`SELECT count(*)::text AS n FROM members`
  return Number(n)
}

// Create an invite. Authorization (tenant admin) is enforced at the route; this
// enforces the SEAT cap (the primary paid lever). UNLIMITED (self-host) has
// maxSeats = Infinity → the isFinite gate skips the check entirely = Community
// First. Returns the PLAINTEXT token so the caller can build the link + email it;
// only the hash is persisted.
export async function createInvite(
  db: TenantDb,
  args: { tenantId: string; plan: string; invitedBy: string; email: string | null; role: InviteRole },
): Promise<{ id: string; token: string; expiresAt: Date }> {
  const ent = resolveEntitlements(args.plan)
  if (isFinite(ent.maxSeats) && (await seatsReservable(db.sql)) >= ent.maxSeats) {
    throw Object.assign(new Error('seat limit reached'), { statusCode: 403, code: 'seat_limit' })
  }
  const token = generateToken()
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS)
  const [row] = await db.sql<[{ id: string }]>`
    INSERT INTO invites (tenant_id, token_hash, email, role, invited_by, expires_at)
    VALUES (${args.tenantId}, ${hashInviteToken(token)}, ${args.email}, ${args.role}, ${args.invitedBy}, ${expiresAt})
    RETURNING id
  `
  return { id: row.id, token, expiresAt }
}

// Accept an invite: turn a verified-but-not-yet-member identity into a member.
// Returns true if THIS call granted membership; false if the token is unknown,
// expired, already consumed, revoked, or belongs to another tenant (all of which
// must be indistinguishable to the caller). Throws (statusCode 403) only when the
// seat cap is hit, so that case can be surfaced distinctly from "bad invite".
//
// ADR-003: the invite flip + member INSERT happen in one tx; FGA is written LAST,
// so a FGA failure rolls back the accept and the member row (no half member).
export async function acceptInvite(
  deps: { db: TenantDb; fga: OpenFgaClient },
  tenant: { id: string; plan: string },
  token: string,
  claims: { sub: string; email?: string | null; name?: string | null },
): Promise<boolean> {
  return deps.db.tx(async (tx) => {
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
    const role = flipped[0]!.role

    // Re-check the seat cap at the moment membership is actually created (a pending
    // invite reserved a seat, but races / revocations mean we verify against live
    // members). Throw → the whole tx (including the invite flip) rolls back.
    const ent = resolveEntitlements(tenant.plan)
    if (isFinite(ent.maxSeats) && (await seatsConsumed(tx)) >= ent.maxSeats) {
      throw Object.assign(new Error('seat limit reached'), { statusCode: 403, code: 'seat_limit' })
    }

    await tx`
      INSERT INTO members (tenant_id, sub, email, display_name, role)
      VALUES (${tenant.id}, ${claims.sub}, ${claims.email ?? null}, ${claims.name ?? null}, ${role})
    `
    // FGA LAST (ADR-003): failure throws → tx rollback → no member row, invite
    // stays pending (its flip is undone too).
    await writeTuples(deps.fga, memberTuples(tenant.id, claims.sub, role))
    return true
  })
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
