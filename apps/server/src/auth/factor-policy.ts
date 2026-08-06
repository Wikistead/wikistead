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
