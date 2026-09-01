// Tenant invites (P1.4). The third membership-grant path — the open-ended,
// fully-normal one (after Cloud signup's provisionTenant and the bounded CE
// the operator route). All three share ADR-003: DB writes first, FGA last, throw
// → full rollback, so a member never exists in DB without its FGA grant (or vice
// versa).
//
// Token discipline mirrors the other short-lived secrets in this codebase (guest
// token / signup session / OIDC state): random 256-bit, plaintext ONLY in the
// emailed link, SHA-256 hash at rest (like API keys), tenant-bound, role-bound,
// short-lived, consume-once, admin-revocable.
import { createHash, randomBytes, randomUUID } from 'node:crypto'
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
/**
 * Is this address already a member of this tenant?
 *
 * #606: the one question both ends of the password-invite flow ask — the issue path so the admin is
 * told, and the acceptance path because an invite issued before somebody joined is still a valid token
 * afterwards. Two copies of this comparison is how the two ends would come to disagree about what
 * counts as the same address.
 */
export async function memberWithEmail(sql: Sql, tenantId: string, email: string | null | undefined): Promise<boolean> {
  const wanted = (email ?? '').trim().toLowerCase()
  if (!wanted) return false
  const [hit] = await sql<{ sub: string }[]>`
    SELECT sub FROM members WHERE tenant_id = ${tenantId} AND lower(email) = ${wanted} LIMIT 1`
  return !!hit
}

export async function createInvite(
  db: TenantDb,
  args: {
    tenantId: string; plan: string; invitedBy: string; email: string | null; role: InviteRole; roleId?: string | null
    // #568 / ADR-198 §2: 'local' means the person sets a PASSWORD during acceptance instead of
    // signing in at an IdP. Refused at ISSUE time when it cannot work — no email to be the
    // identifier, or a tenant that does not offer password sign-in — because the admin is still
    // looking at the screen here, while the person who would see a failure at acceptance did not
    // choose any of this.
    kind?: 'oidc' | 'local'
    // #616 / ADR-212 slice 1 (user ruling, option (i)): an OPERATOR recovery may step over the
    // tenant's own SSO stance, with the operator ledger carrying the accountability — the same trade
    // `tenant:login-methods` already makes with the 409 lockout guards. Never set from request data:
    // the only caller is the CLI, which runs on admin DB credentials with no HTTP surface.
    //
    // It steps over exactly ONE thing. Measured (adminless-invite-probe-616): the stance guard lives
    // inside the `kind: 'local'` branch and bites only when a federated way in is real, so the domain
    // is "a password recovery into a tenant that has a working IdP and nobody seated". The stance
    // itself is NOT rewritten — a tenant's policy survives its own rescue (ruling condition 3).
    operatorOverride?: boolean
  },
): Promise<{ id: string; token: string; expiresAt: Date; seatWarning: boolean }> {
  const ent = resolveEntitlements(args.plan)
  const seatWarning = isFinite(ent.maxSeats) && (await seatsReservable(db.sql)) >= ent.maxSeats
  // #582 / ADR-202 §2: only a TENANT-scope custom role can ride an invite — a resource role has no
  // resource here. Refused at ISSUE time, where the admin is still looking at the screen, rather than
  // at acceptance, where the person who sees the failure did not choose the role.
  if (args.roleId) {
    const [role] = await db.sql<{ id: string; scope: string }[]>`SELECT id, scope FROM roles WHERE id = ${args.roleId}`
    if (!role) throw Object.assign(new Error('not found'), { statusCode: 404 })
    if (role.scope !== 'tenant') {
      throw Object.assign(new Error('an invite can only carry a tenant-scope role'), { statusCode: 400 })
    }
  }
  const kind = args.kind ?? 'oidc'
  if (kind === 'local') {
    if (!args.email) {
      throw Object.assign(new Error('a password invite needs an email address — it becomes the sign-in name'), { statusCode: 400 })
    }
    const { localLoginEnabled } = await import('./login-methods.js')
    if (!(await localLoginEnabled(db))) {
      throw Object.assign(new Error('password sign-in is off for this tenant — turn it on before inviting with a password'), { statusCode: 400, code: 'local_login_disabled' })
    }
    // #605 / ADR-210 §4 row 8: a password invite mints a NEW person, and while SSO is required a new
    // person cannot arrive by password. ADMIN surface → an explicit refusal with the reason (ADR-195
    // §9), never the uniform not-found a stranger gets.
    const { resolveSsoStance } = await import('./sso-stance.js')
    if (!args.operatorOverride && (await resolveSsoStance(db, { plan: args.plan })).biting) {
      throw Object.assign(new Error('SSO is required for this tenant — a new member cannot be invited with a password while it is on'), { statusCode: 400, code: 'sso_required' })
    }
    // #606: a password invite MINTS a new identity (`acceptLocalInvite` always allocates a fresh
    // `wlocal_` sub), so sending one to somebody who is already in this tenant does not give them a
    // password — it makes a second person who happens to share their address, holding a second seat and
    // a second set of FGA tuples. Refused at ISSUE time, like the two checks above, because the admin is
    // standing here and the person who would meet the consequence never chose any of it.
    //
    // The address is compared case-insensitively: an invite's identifier is lower-cased on acceptance,
    // so `Ada@example.com` and `ada@example.com` are the same sign-in name and must be the same answer.
    if (await memberWithEmail(db.sql, args.tenantId, args.email)) {
      throw Object.assign(
        new Error('that address already belongs to a member of this tenant — an invite would create a second account for them'),
        { statusCode: 400, code: 'already_member' },
      )
    }
  }
  const token = generateToken()
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS)
  const [row] = await db.sql<[{ id: string }]>`
    INSERT INTO invites (tenant_id, token_hash, email, role, invited_by, expires_at, role_id, kind, operator_issued)
    VALUES (${args.tenantId}, ${hashInviteToken(token)}, ${args.email}, ${args.role}, ${args.invitedBy}, ${expiresAt}, ${args.roleId ?? null}, ${kind}, ${args.operatorOverride === true})
    RETURNING id
  `
  return { id: row.id, token, expiresAt, seatWarning }
}

/** Give a pending invite a fresh link. Returns null if there is no pending invite by that id.
 *
 * #638 (user ruling): an invite that was never received used to be a dead end. The password
 * entrance beside it has had a re-issue since #626, but the invite had neither a resend nor a way to
 * read the link back — and it is the one that CANNOT be recovered, because in a tenant with no mail
 * configured the link shown once at creation was the only copy. Losing it meant revoking and inviting
 * again, which is a different invite to anybody reading the ledger.
 *
 * RE-ISSUE, not re-display, and the distinction is forced rather than chosen: the token is stored as a
 * SHA-256 hash exactly so a leak of the table is not a leak of the links. Nothing can show the old one
 * again. So a new token replaces it and the old link stops working — which the screen has to say plainly,
 * or an admin hands somebody a link they have just invalidated for the person they mailed it to.
 *
 * Same ROW, deliberately. The seat accounting, the role, the kind and who invited them all belong to the
 * invitation rather than to the link, and minting a second row is how #606 put the same person on two
 * seats. The clock restarts because a link nobody could use should not expire on its original schedule.
 */
export async function reissueInvite(
  db: { sql: Sql },
  id: string,
): Promise<{ token: string; email: string | null; expiresAt: Date } | null> {
  const token = generateToken()
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS)
  const [row] = await db.sql<[{ email: string | null }?]>`
    UPDATE invites SET token_hash = ${hashInviteToken(token)}, expires_at = ${expiresAt}
     WHERE id = ${id} AND status = 'pending'
    RETURNING email`
  return row ? { token, email: row.email, expiresAt } : null
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
// #995 / ADR-269 §2.1: a refusal that happens AFTER the invite has been flipped to `accepted`. Thrown
// from inside the tx callback so postgres.js rolls the flip back — a callback that RETURNS false
// commits, which is how a refused acceptance used to leave `status='accepted'` with no member behind
// it (and, because reissue/revoke both act on `status='pending'`, an invite the administrator could
// neither resend nor revoke). Caught by the exported function itself, never by a route: the routes
// translate only the codes they know and turn anything else into a 500.
class InviteRefused extends Error {
  readonly code = 'invite_refused' as const
  constructor(readonly inviteId: string, readonly reason: string) {
    super(`invite acceptance refused: ${reason}`)
  }
}

// ADR-269 §2.3 as ruled on #995: the signal is a structured log line, present in EVERY
// deployment — not an audit-ledger row, which a tenant without that entitlement would never see.
// It names the invite (which the administrator already has in front of them) and the reason; never
// the address, and never the claimant, who is by construction not a member of this tenant.
export interface InviteLog { warn: (obj: Record<string, unknown>, msg: string) => void }
function reportRefusal(log: InviteLog | undefined, tenantId: string, e: InviteRefused): void {
  ;(log ?? console).warn(
    { tenantId, inviteId: e.inviteId, reason: e.reason },
    'invite acceptance refused after the token was proven; the invite stays pending',
  )
}

//
// ADR-003: the invite flip + member INSERT happen in one tx; FGA is written LAST, so a FGA
// failure rolls back the accept and the member row (no half member).
export async function acceptInvite(
  deps: { db: TenantDb; fga: OpenFgaClient; log?: InviteLog },
  tenant: { id: string; plan: string },
  token: string,
  claims: { sub: string; email?: string | null; name?: string | null },
  // #554 S4 / §5 rev3 gate flip: set only by a caller that validated the RAW sub and minted the
  // namespaced form itself. Never set from request data.
  opts?: { subMintedInternally?: boolean },
): Promise<boolean> {
  // #568 review B2: this door accepts OIDC invites ONLY. Without the `kind` filter a PASSWORD invite
  // could be consumed by signing in at the IdP — the token would be burned on a member seated as
  // `identity_source='oidc'`, and the credential the invite existed to create would never be
  // written, with nothing telling either party it had gone wrong. `acceptLocalInvite` guards the
  // mirror image; this is the other half of the pair.
  //
  // #554 / ADR-197 §5 (S0): a claims.sub wearing a reserved connection/local prefix (or FGA-unsafe
  // length) never becomes a member through an invite — refused as this seam's own failure shape
  // (indistinguishable from an unknown/expired invite).
  if (!opts?.subMintedInternally) {
    const { externalSubViolation } = await import('./reserved-subs.js')
    if (externalSubViolation(claims.sub)) return false
  }
  let accepted: boolean
  try {
    accepted = await deps.db.tx(async (tx) => {
    // Serialize seat decisions for this tenant for the rest of the tx (atomic cap check).
    await lockSeats(tx, tenant.id)

    // Consume-once: only a pending, non-expired invite for THIS tenant wins, and
    // exactly one concurrent caller can flip it (single UPDATE ... RETURNING).
    // #582: the flip also returns the carried role and WHO invited them. The inviter is the audit
    // actor: `assignRoleTxCore` records `user:<actorSub>`, so passing the accepting member would write
    // "they gave themselves this role" into the ledger.
    const flipped = await tx<{ id: string; role: InviteRole; role_id: string | null; invited_by: string }[]>`
      UPDATE invites
         SET status = 'accepted', accepted_sub = ${claims.sub}, accepted_at = now()
       WHERE token_hash = ${hashInviteToken(token)}
         AND tenant_id  = ${tenant.id}
         AND kind       = 'oidc'
         AND status     = 'pending'
         AND expires_at > now()
      RETURNING id, role, role_id, invited_by
    `
    if (flipped.length === 0) return false // unknown / expired / consumed / revoked / cross-tenant
    // The seat fortress (lock already held above): idempotent for an existing member, cap-checked,
    // atomic member INSERT + FGA. Shared with #101 auto-enrolment so EVERY new-member path goes through
    // the ONE gate. Returns whether it created; acceptInvite answers true either way (membership held).
    let seated: 'created' | 'exists'
    try {
      seated = await enrolUnderSeatCap(tx, deps.fga, tenant, claims, flipped[0]!.role, 'invite')
    } catch (e) {
      // ADR-259 §3.4: an invite door stays uniform (somebody holding a token has proved nothing about
      // the address) — the SAME "this link no longer works" answer acceptLocalInvite already gives for
      // its own address collision, not a signal that tells this caller who already owns the address.
      // seat_limit rethrows (the caller distinguishes it from a bad token, unchanged from before).
      // #995: thrown, not returned — the flip above must roll back with the refusal.
      if ((e as { code?: string }).code === 'address_taken') throw new InviteRefused(flipped[0]!.id, 'address_taken')
      throw e
    }
    await applyInviteRole(tx, deps.fga, tenant, claims.sub, flipped[0]!, seated)
    return true
    })
  } catch (e) {
    if (!(e instanceof InviteRefused)) throw e
    reportRefusal(deps.log, tenant.id, e)
    return false
  }
  return accepted
}

// #568 / ADR-198 §2: accept a LOCAL invite — the variant where the person sets a password instead of
// signing in at an IdP. One transaction: consume the invite, mint the subject, seat the member, write
// the credential. Anything that throws rolls all of it back, so a half-accepted invite (a member with
// no password, or a password with no membership) is not a state this can reach.
//
// The subject is minted HERE, not asserted: `wlocal_<uuid>` in the space #569 reserved. The request
// carries an identifier and a password and never a sub, so there is nothing for the external-subject
// gate to inspect — it is bypassed structurally rather than exempted.
//
// A stale link for a tenant that has since turned password sign-in OFF answers exactly like a
// consumed one (M8). "Your link expired" and "this tenant stopped offering passwords" are the same
// sentence to whoever is holding the link, and telling them apart would say something about the
// tenant to someone who is not in it.
export async function acceptLocalInvite(
  deps: { db: TenantDb; fga: OpenFgaClient; log?: InviteLog },
  tenant: { id: string; plan: string },
  token: string,
  password: string,
  // #807: the name this person will be known by here. A local invite mints a brand-new identity, and
  // nothing else in this flow knows what to call them — an OIDC invite gets a name from the IdP at
  // every login, this one had no source at all, so the initial administrator of a self-hosted
  // workspace appeared nameless in the roster, on presence carets and in mentions.
  //
  // Optional on the wire on purpose. The screen asks for it and will not submit without one, but a
  // tab opened before that shipped must still be able to accept its invitation: refusing here would
  // tell somebody holding a REAL invite that their link is dead, which is the one thing this flow's
  // uniform 404 exists to avoid saying wrongly.
  displayName?: string,
): Promise<{ ok: true; sub: string; operatorIssued: boolean } | { ok: false }> {
  const { localLoginEnabled } = await import('./login-methods.js')
  if (!(await localLoginEnabled(deps.db))) return { ok: false }
  // #605 / ADR-210 §4 row 9: the sub does not exist until acceptance mints it, so there is nobody to
  // exempt — while the stance bites, a local invite link answers as the uniform dead link.
  //
  // #616 (ruling, option (i)): EXCEPT the one invite an operator break-glass issued. The stance
  // refuses in two places, and overriding only the issue side hands the operator a link that dies here
  // instead — measured, on the first run of `local-admin-cli-616`. The exemption is carried by THE
  // INVITE ROW, so it is one link, it expires with the invite's own TTL, and the stance still applies
  // to everyone else and to this person the moment they are in. The row is read before the stance is
  // consulted; an unknown token falls through to the same dead-link answer as before.
  const { resolveSsoStance } = await import('./sso-stance.js')
  const [operatorRow] = await deps.db.sql<{ operator_issued: boolean }[]>`
    SELECT operator_issued FROM invites WHERE token_hash = ${hashInviteToken(token)} AND status = 'pending' LIMIT 1`
  if (operatorRow?.operator_issued !== true && (await resolveSsoStance(deps.db, tenant)).biting) return { ok: false }
  const { hashPassword } = await import('./password-hash.js')
  const { validatePasswordPolicy } = await import('./password-policy.js')
  if (!validatePasswordPolicy(password)) {
    throw Object.assign(new Error('password does not meet the policy'), { statusCode: 400, code: 'weak_password' })
  }
  // The KDF runs OUTSIDE the transaction: it holds a CPU for ~60ms and a database connection has no
  // business waiting for it (the share-link lesson).
  const passwordHash = await hashPassword(password)
  const sub = `wlocal_${randomUUID()}`

  try {
    return await deps.db.tx(async (tx) => {
    await lockSeats(tx, tenant.id)
    const flipped = await tx<{ id: string; role: InviteRole; role_id: string | null; invited_by: string; email: string | null }[]>`
      UPDATE invites
         SET status = 'accepted', accepted_sub = ${sub}, accepted_at = now()
       WHERE token_hash = ${hashInviteToken(token)}
         AND tenant_id  = ${tenant.id}
         AND kind       = 'local'
         AND status     = 'pending'
         AND expires_at > now()
      RETURNING id, role, role_id, invited_by, email
    `
    if (flipped.length === 0) return { ok: false as const } // unknown / expired / consumed / revoked / not a local invite
    const invite = flipped[0]!
    // #995 / ADR-269 §2.1: every refusal from here on is a THROW, so the flip above rolls back. All
    // three pre-checks and the fortress's own refusal share the commit-on-return defect (§1.3).
    const refuse = (reason: string): never => { throw new InviteRefused(invite.id, reason) }
    const identifier = (invite.email ?? '').trim().toLowerCase()
    if (!identifier) refuse('no_identifier') // the CHECK makes this unreachable; belt and braces
    // Trimmed, and empty means absent — the same normalisation the account screen applies to an
    // edited display name (`account.ts`), so the two doors cannot disagree about what a name is.
    const claims = { sub, email: identifier, name: displayName?.trim() ? displayName.trim() : null }
    // review N3: the identifier collision is checked BEFORE any FGA write. enrolUnderSeatCap writes
    // the membership tuple, and FGA does not roll back with the transaction — so a UNIQUE violation
    // on the credential INSERT afterwards left a tuple for a member the database then discarded.
    // Asking first turns that into the ordinary "this link no longer works" answer.
    const taken = await tx`SELECT 1 FROM local_credentials WHERE identifier = ${identifier}`
    if (taken.length > 0) refuse('identifier_taken')
    // #606: and the same question the issue path asked, asked again here. A link issued while the
    // address was free is still a valid token after that person joins by some other route (SCIM, an
    // OIDC first sign-in), and accepting it then would seat them a SECOND time under a new sub. The
    // answer is the ordinary "this link no longer works": the same uniform outcome as an expired or
    // consumed token, which is all this path can say without telling a stranger who is a member here.
    if (await memberWithEmail(tx, tenant.id, identifier)) refuse('address_taken')
    // ADR-259 §3.4: the fortress asks the same address question again (defence in depth — the check
    // above is this door's own pre-existing guard, unchanged). An invite door stays uniform either way.
    try {
      await enrolUnderSeatCap(tx, deps.fga, tenant, claims, invite.role, 'invite', 'local')
    } catch (e) {
      if ((e as { code?: string }).code === 'address_taken') refuse('address_taken')
      throw e
    }
    await tx`INSERT INTO local_credentials (tenant_id, member_sub, identifier, password_hash)
             VALUES (${tenant.id}, ${sub}, ${identifier}, ${passwordHash})`
    await applyInviteRole(tx, deps.fga, tenant, sub, invite, 'created')
    // #655 review reject: the caller needs to know WHICH door this was. An operator break-glass
    // invite is the one #616 exempted from the SSO stance, and ADR-219 §4 says the same exemption
    // crosses the second-factor requirement — otherwise the way back in when everything else is shut
    // gets shut by the thing it exists to get around. The row is already read above for the stance, so
    // this is one field on the way out rather than a second look at a single-use token.
    return { ok: true as const, sub, operatorIssued: operatorRow?.operator_issued === true }
    })
  } catch (e) {
    if (!(e instanceof InviteRefused)) throw e
    reportRefusal(deps.log, tenant.id, e)
    return { ok: false as const }
  }
}

// #582 / ADR-202 §2: apply the role the invite carried, in the SAME tx that seated the member.
//
// Three decisions the ADR made explicit, all visible here:
//   - the role rides the tier, never replaces it — tenant membership IS the tier (#579's asymmetry).
//   - if the `customRoles` entitlement is gone by acceptance, the person is seated with their tier and
//     the dropped role is AUDITED. Refusing the acceptance would keep someone out of a tenant over a
//     billing state they cannot see; dropping it silently would be a role nobody can account for.
//   - a NEW member only. An existing member accepting an invite keeps what they have — an invite is
//     how someone JOINS, and using it to top up a colleague's roles is a different act with a
//     different screen.
async function applyInviteRole(
  tx: Sql, fga: OpenFgaClient, tenant: { id: string; plan: string }, sub: string,
  invite: { role_id: string | null; invited_by: string }, seated: 'created' | 'exists',
): Promise<void> {
  if (!invite.role_id || seated !== 'created') return
  const { assignRoleWithinTx } = await import('../routes/roles.js')
  const { auditIfEntitled } = await import('../audit/sink.js')
  const [role] = await tx<{ id: string; capabilities: string[]; scope: string }[]>`
    SELECT id, capabilities, scope FROM roles WHERE id = ${invite.role_id}`
  // The pointer can be null by now (ON DELETE SET NULL) or the role can have changed scope. Either way
  // the acceptance is NOT silenced: seat them and say what was dropped.
  const entitled = resolveEntitlements(tenant.plan).customRoles
  if (!role || role.scope !== 'tenant' || !entitled) {
    await auditIfEntitled(tx, tenant, {
      actor: `user:${invite.invited_by}`, action: 'invite.role_dropped',
      target: invite.role_id ? `role:${invite.role_id}` : `member:${sub}`,
    }).catch(() => {})
    return
  }
  await assignRoleWithinTx(tx, fga, {
    tenant, roleId: role.id, capabilities: role.capabilities as never[],
    resourceType: 'tenant', resourceId: tenant.id, principal: `user:${sub}`,
    actorSub: invite.invited_by, origin: 'invite', onDuplicate: 'ignore',
  })
}

// THE SEAT FORTRESS (ADR-034), shared by invite accept AND #101 auto-enrolment. The caller MUST already
// hold lockSeats(tx, tenant.id) so the count→compare→insert is one indivisible decision (this re-acquires
// it harmlessly — advisory locks are re-entrant within a tx). Idempotent by identity (an existing member
// consumes no seat, no DB/FGA change, no error). Throws 402 seat_limit for a NEW member over the cap →
// the whole tx rolls back. FGA is written LAST (ADR-003). Returns 'created' | 'exists'.
//
// ADR-259 §3.2: also throws 409 address_taken for a NEW member whose address already belongs to a
// member of this tenant — this is the ONE fortress all three doors pass through (auto-enrol,
// OIDC invite accept, local invite accept), so this is the ONE place that has to look. It runs
// AFTER the membership test (an existing member's own sign-in never collides with itself) and does
// NOT read `email_verified` — the tenant's own IdP can assert that claim, so trusting it here would
// let whoever configures the IdP absorb an existing password member's seat (ADR-259 §2, CVE-2023-3128's
// shape). `via` and `identitySource` are passed through unchanged for the error's own body, so a
// caller can tell an address collision apart from a token failure without re-querying.
export async function enrolUnderSeatCap(
  tx: Sql,
  fga: OpenFgaClient,
  tenant: { id: string; plan: string },
  claims: { sub: string; email?: string | null; name?: string | null },
  role: InviteRole,
  via: 'invite' | 'auto',
  // #568 / ADR-198 §1 M5: who issued this identity. Defaults to 'oidc' so every existing caller is
  // unchanged; the local acceptance transaction passes 'local', which is what makes ADR-190's rule
  // ("only local members may edit their display name") mean what it says — an OIDC member's name
  // comes back from their IdP at every login, so letting them edit it would be a lie.
  identitySource: 'oidc' | 'local' = 'oidc',
): Promise<'created' | 'exists'> {
  await lockSeats(tx, tenant.id)
  if (await isMember(tx, claims.sub)) return 'exists'
  // #930 / ADR-263 §3.1 (owner ruling 2026-08-27, rev2): a seat requires an address. The identity's
  // IdP released no `email` claim — refused HERE, before the seat is spent, rather than seated with
  // no way to ever compare it against a later arrival for the same person (#858's duplicate-seat
  // gap). Checked before `memberWithEmail` deliberately: that predicate can no longer be asked to
  // answer for an address that does not exist, so this floor is a precondition of asking it at all.
  if (!(claims.email ?? '').trim()) {
    throw Object.assign(
      new Error("this identity provider did not release an email address, and every member needs one — configure the connection to release the `email` claim, or invite this person with a password instead"),
      { statusCode: 409, code: 'email_required' },
    )
  }
  if (await memberWithEmail(tx, tenant.id, claims.email)) {
    throw Object.assign(new Error('that address already belongs to a member of this tenant'), { statusCode: 409, code: 'address_taken' })
  }
  const ent = resolveEntitlements(tenant.plan)
  if (isFinite(ent.maxSeats) && (await billableMemberCount(tx)) >= ent.maxSeats) {
    throw Object.assign(new Error('seat limit reached'), { statusCode: 402, code: 'seat_limit' })
  }
  await tx`
    INSERT INTO members (tenant_id, sub, email, display_name, role, identity_source)
    VALUES (${tenant.id}, ${claims.sub}, ${claims.email ?? null}, ${claims.name ?? null}, ${role}, ${identitySource})
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
