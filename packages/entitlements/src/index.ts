// Entitlement resolution: the single source of plan-conditional logic.
// "if (plan === ...)" is prohibited in routes, services, and collab.
// All plan limits and feature flags resolve through resolveEntitlements().

export interface Entitlements {
  // Gate for share link ISSUANCE only.
  // collab onAuthenticate does NOT check this — existing links remain usable
  // after a downgrade so they are not silently invalidated. New issuance is
  // blocked; existing links expire naturally or via explicit revocation.
  guestAccess: boolean

  // Maximum number of spaces per tenant. Infinity = unlimited.
  // Enforced in POST /spaces with a count query (see that handler for the
  // concurrency TODO).
  maxSpaces: number

  // Maximum active members per tenant. Infinity = unlimited.
  // TODO(phase: auth): enforce in POST /members when member invite is added.
  maxMembersPerTenant: number
}

// Canonical plan → entitlement table. Add rows here when new plans are introduced.
// Enterprise tiers with custom limits override this at runtime (future work).
const PLANS: Record<string, Entitlements> = {
  free: { guestAccess: false, maxSpaces: 3,       maxMembersPerTenant: 5  },
  pro:  { guestAccess: true,  maxSpaces: Infinity, maxMembersPerTenant: 50 },
}

export function resolveEntitlements(plan: string): Entitlements {
  return PLANS[plan] ?? PLANS['free']!
}
