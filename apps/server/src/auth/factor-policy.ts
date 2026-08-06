// What the second-factor policy admits (#652 slice 1 / ADR-219 §2 §3 §4).
//
// A pure decision, deliberately separated from everything that will call it. The wiring, the tenant
// switch and the interstitial are the rest of #652 — the switch is still with the ruling (#644), and
// the interstitial is unreachable without enforcement, so it belongs in the same commit as the wiring
// rather than this one.
//
// This is the piece worth pinning on its own, because it is the piece most likely to be implemented
// backwards. ADR-219 §2 says a session with no recorded door reads as unsatisfied; §3 rules that
// federated sign-ins are out of the policy's scope entirely. Read one after the other and the obvious
// implementation is "no factor recorded → ask for one", which sends every OIDC member to an
// interstitial and reverses §3 without anybody editing it. The table below is the ruling; a caller can
// now be wrong about how to call this, but not about what it decides.
import type { TenantDb } from '../db/index.js'
import { doorOf, type SessionData, type SessionDoor } from './session.js'

/** What a request may do about a session, once the policy is on. */
export type FactorVerdict =
  /** proceed: either the policy is off, or this door is not the policy's business, or it was answered */
  | 'admit'
  /** the member must enrol or present a factor before going further (ADR-219 §6's interstitial) */
  | 'require-factor'

export type PolicyInput = {
  /** whether THIS tenant requires a second factor. Where that comes from is the rest of #652. */
  policyOn: boolean
  door: SessionDoor
}

/**
 * The table, in one place.
 *
 *   policy off        → admit, whatever the door. A policy nobody turned on decides nothing.
 *   local+factor      → admit. The factor was answered at the door.
 *   federated         → admit. ADR-219 §3: the product cannot verify what the IdP asked, and asking
 *                       anyway would be a second factor demanded in ignorance of the first. NOT a
 *                       "close enough" — it is the ruling, and the case this file exists to protect.
 *   operator          → admit. ADR-219 §4: the break-glass path crosses requirements on purpose. It
 *                       already crosses the SSO stance; a self-hoster who has lost every authenticator
 *                       would otherwise lose the tenant.
 *   local             → require-factor. The one door the policy is about.
 *   (absent)          → `doorOf` reads it as `local`, so: require-factor. Grandfathering an old cookie
 *                       would make "hold one from last week" the way around a rule introduced this
 *                       week — a bypass, not a migration.
 */
export function factorVerdict({ policyOn, door }: PolicyInput): FactorVerdict {
  if (!policyOn) return 'admit'
  switch (door) {
    case 'local+factor':
    case 'federated':
    case 'operator':
      return 'admit'
    case 'local':
      return 'require-factor'
  }
}

/** The same question asked of a session, so no caller has to remember to go through `doorOf`. */
export const sessionVerdict = (s: Pick<SessionData, 'door'>, policyOn: boolean): FactorVerdict =>
  factorVerdict({ policyOn, door: doorOf(s) })

/**
 * The principals the policy does NOT cover (ADR-219 §5), named rather than left to the wiring.
 *
 * Four of the five ways a member principal is created never touch a session (`app.ts`: dev-token, the
 * MCP OAuth provider, an API key, an OIDC bearer), so a check written as "look at the session" simply
 * does not run for them — which reads as an exemption nobody decided. It IS an exemption, and it is
 * this one: a key or a bearer is a credential the member already proved themselves to create, and
 * issuing one re-authenticates (§8). Guests are out of scope entirely — anonymous editing through a
 * share link is the core of this product and there is no subject to attach a factor to.
 *
 * Exported so the wiring slice can assert against it instead of restating it.
 */
export const PRINCIPALS_OUTSIDE_POLICY = ['api-key', 'oidc-bearer', 'mcp-oauth', 'dev-token', 'guest'] as const

// ── the tenant's stance, and who may set it (#652 slice 2) ───────────────────────────────────────

/**
 * Whether THIS tenant requires a second factor. Migration 118, beside the other stances.
 *
 * A tenant with no `tenant_login_prefs` row has never decided anything, which is not the same as
 * deciding "no" — but it produces the same answer, and the alternative (treating an absent row as a
 * requirement) would lock out every tenant that predates the column.
 */
export async function secondFactorRequired(db: TenantDb): Promise<boolean> {
  const [row] = await db.sql<[{ second_factor_required: boolean }?]>`
    SELECT second_factor_required FROM tenant_login_prefs LIMIT 1`
  return row?.second_factor_required === true
}

/**
 * ⚠️ THE EDITION SEAM, and it is deliberately one function.
 *
 * ADR-219 §10 was ruled EE for the tenant policy (#644 ruling 2), and the independent review of
 * rev3 found that ruling collides head-on with ADR-210 §8, which ruled the SAME shape — a tenant-wide
 * constraint on how everybody signs in — CE on 2026-08-04, with the reason "charging for it would mean
 * the cheaper plan is the one that cannot hold a security position". Sharper still: ADR-219 §3
 * identifies this feature's population as tenants on `platform-oidc`, which is exactly the set that
 * CANNOT turn SSO required on, so pricing the factor policy would price out the population §3 named.
 * Raised on #644 and awaiting the ruling.
 *
 * Until it lands this returns true — the CE reading, which is the recommendation and the one that
 * matches ADR-210 §8's precedent. If the ruling goes the other way, THIS FUNCTION consults
 * `resolveEntitlements(tenant.plan)` and nothing else changes: the seam exists so the answer is in one
 * place rather than as an `if (plan === …)` beside every check, which is the constraint this repository
 * already holds (packages/entitlements/src/index.ts:2).
 */
export function mfaPolicyEntitled(_tenant: { plan: string }): boolean {
  return true
}

/**
 * Whether this tenant has an admin who can actually present a factor.
 *
 * The write-time precondition ADR-219 §4 mirrors from #605: turning the policy on while nobody can
 * satisfy it is a lock-out with a success response. CONFIRMED factors only — an abandoned enrolment is
 * somebody who has proved nothing, and counting it would let the switch be satisfied by starting an
 * enrolment and walking away.
 *
 * `role = 'admin'` on the members row is the tier, which is what #605's own guard reads; a custom role
 * carrying admin capabilities is a different question and is not one this precondition can ask without
 * an FGA round trip per member.
 */
export async function adminWithFactorCount(db: TenantDb): Promise<number> {
  const [row] = await db.sql<[{ n: number }?]>`
    SELECT count(DISTINCT m.sub)::int AS n
    FROM members m
    JOIN member_factors f ON f.member_sub = m.sub AND f.confirmed_at IS NOT NULL
    WHERE m.role = 'admin' AND m.deactivated_at IS NULL`
  return row?.n ?? 0
}

/**
 * Whether removing `factorId` would leave the tenant with no admin who can sign in under the policy.
 *
 * The outbound half of the two-sided guard. #605's is at `admin-login-methods.ts:220-243` and says the
 * same thing about the last credentialed exemption: "the same floor the ON precondition set, or the
 * switch's own requirement dies one delete later".
 *
 * Asked as "would this member still hold one afterwards, and if not, is anybody else left" rather than
 * by counting rows: a member with two authenticators giving one up changes nothing, and a guard that
 * counted admins-with-factors would refuse them for no reason.
 */
export async function wouldStrandTenant(
  db: TenantDb,
  args: { memberSub: string; factorId: string },
): Promise<boolean> {
  const [row] = await db.sql<[{ mine: number; others: number }?]>`
    SELECT
      (SELECT count(*)::int FROM member_factors
        WHERE member_sub = ${args.memberSub} AND confirmed_at IS NOT NULL AND id <> ${args.factorId}) AS mine,
      (SELECT count(DISTINCT m.sub)::int FROM members m
        JOIN member_factors f ON f.member_sub = m.sub AND f.confirmed_at IS NOT NULL
        WHERE m.role = 'admin' AND m.deactivated_at IS NULL AND m.sub <> ${args.memberSub}) AS others`
  if (!row) return false
  // Somebody else can still get in, or this member keeps another factor: nothing is stranded.
  if (row.others > 0 || row.mine > 0) return false
  // …and only an ADMIN can strand a tenant. A member losing their last factor locks nobody else out.
  const [me] = await db.sql<[{ role: string }?]>`SELECT role FROM members WHERE sub = ${args.memberSub}`
  return me?.role === 'admin'
}
