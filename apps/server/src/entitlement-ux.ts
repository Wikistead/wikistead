// Access-loss disclosure shapes (#109 / ADR-072), codified in ONE place.
//
// Two reasons a user loses access — with OPPOSITE disclosure rules; conflating them is a bug:
//   authz loss (revoked / restricted / not yours) → EXISTENCE-HIDING 404, indistinguishable from
//     "does not exist". Never reveal that restricted content exists; never offer "upgrade". Use
//     notFound(). (This is the standing 404-unified convention.)
//   entitlement loss (a plan lever is off) → NON-DESTRUCTIVE 403 with an owner-actionable
//     affordance: stored data is preserved and a re-upgrade restores it. Use entitlementDenied()
//     — it sets `upgrade: true` so the client renders "upgrade to restore (your data is kept)".
//
// A 404 for an entitlement loss would imply data was deleted (it wasn't); an "upgrade" hint for an
// authz loss would leak that restricted content exists. So they are deliberately distinct helpers.

export interface AppError extends Error {
  statusCode: number
  code?: string
  upgrade?: boolean
}

// Existence-hiding 404 — the authz-loss / not-found shape. No "upgrade", no "you lack access".
export function notFound(message = 'not found'): AppError {
  return Object.assign(new Error(message), { statusCode: 404 }) as AppError
}

// Entitlement-gate denial: 403 + a stable `<feature>_not_entitled` code + `upgrade: true`. NEVER a
// 404 (that would imply the feature/data is gone). The stored data is untouched — re-upgrade restores.
export function entitlementDenied(feature: string, message?: string): AppError {
  return Object.assign(new Error(message ?? `${feature} is not available on this plan`), {
    statusCode: 403,
    code: `${feature}_not_entitled`,
    upgrade: true,
  }) as AppError
}
