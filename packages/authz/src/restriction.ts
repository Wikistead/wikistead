import type { ResourceRef } from '@wikistead/types'
import { authzScopeForCheck, type AuthzScope } from './scope.js'

// #637 / ADR-216 §5, §7: the AND that a restriction adds at the authorization primitives.
//
// Two things live here and they are deliberately not the same thing.
//
// The SEAM is CE. Whether a restriction is honoured cannot be an Enterprise feature: a deployment that
// removes the EE overlay would then stop honouring the restrictions already stamped on credentials that
// exist, and every narrowed key would widen back to its owner's full rights. A leaked key getting BIGGER
// when a package is removed is the wrong direction, and it is the same shape ADR-207 §R4-3 removed when
// it took the entitlement gate off `revoke`. So CE owns the seam and, more importantly, owns the
// REFUSAL: if a request carries a restriction and no evaluator is registered to interpret it, the answer
// is no.
//
// The RULE is EE. What a `spaces` restriction means — which resource kinds it covers, how a page maps to
// a space, what the key's list actually contains — is governance, and it is registered from the EE
// composition root.
//
// This is the SECOND layer, not the guarantee. Nineteen raw FGA calls (measured 2026-08-06; ADR-216
// says twelve, and the scan in `raw-fga-calls-637` is the authority) never pass
// through the primitives, so completeness rides the allow-list of routes a narrowed key may enter. Said
// in this order on purpose: the other order invites adding a route and trusting this to catch what it
// does.

/**
 * Decides whether a restricted principal may reach one resource.
 *
 * Returns a verdict rather than a boolean so "no" and "I cannot tell" stay distinguishable — the second
 * one must not be answered as the first, and it must never be answered as yes.
 */
export type AuthzRestrictionEvaluator = (
  restriction: NonNullable<AuthzScope['restriction']>,
  resource: ResourceRef,
  scope: AuthzScope,
) => Promise<'allow' | 'deny' | 'unresolvable'>

let _evaluator: AuthzRestrictionEvaluator | null = null

export function registerAuthzRestrictionEvaluator(e: AuthzRestrictionEvaluator): void { _evaluator = e }
export function getAuthzRestrictionEvaluator(): AuthzRestrictionEvaluator | null { return _evaluator }
/** Test-only: registry state must not leak between suites. */
export function resetAuthzRestrictionEvaluator(): void { _evaluator = null }

// ADR-216 §4 asked for tenant membership and tenant admin to be exempt from the AND — "is this person a
// member" is not a question about a space, and refusing it would make confinement break the product
// rather than confine it. No exemption is needed: `isTenantMember` and `isTenantAdmin` call `fga.check`
// directly and never pass through a primitive, so they are among the raw calls the allow-list covers and
// this code cannot reach them. Written down rather than left as an exemption that can never fire — a
// list of types nothing can put in it reads like a guarantee and is only a comment.

/**
 * True when the current scope permits reaching `resource`.
 *
 * Called by every primitive. In the ordinary case — no restriction in scope — it is one property read
 * and a return, which is what the request path pays for the mechanism.
 */
export async function restrictionAllows(resource: ResourceRef): Promise<boolean> {
  const scope = authzScopeForCheck()
  const restriction = scope.restriction
  if (!restriction) return true
  const evaluate = _evaluator
  // A restriction nobody can interpret is a restriction that stands. The alternative — treating an
  // absent evaluator as "no restriction" — is precisely how removing a package would widen a key.
  if (!evaluate) return false
  const verdict = await evaluate(restriction, resource, scope)
  return verdict === 'allow'
}
