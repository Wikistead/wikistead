// Entitlement resolution: the single source of plan-conditional logic.
// "if (plan === ...)" is prohibited in routes, services, and collab.
// All plan limits and feature flags resolve through resolveEntitlements().

export interface Entitlements {
  // Gate for share link ISSUANCE only. The anonymous-collab differentiator is
  // FREE (it is the product's viral hook), so every current plan has this true;
  // the flag stays so a future restricted tier can disable issuance in one place.
  // collab onAuthenticate does NOT check this — existing links remain usable
  // after a downgrade so they are not silently invalidated. New issuance is
  // gated; existing links expire naturally or via explicit revocation.
  guestAccess: boolean

  // Maximum number of spaces per tenant. Infinity = unlimited.
  // Enforced in POST /spaces with a count query (see that handler for the
  // concurrency TODO).
  maxSpaces: number

  // Maximum active members per tenant. Infinity = unlimited.
  // TODO(phase: auth): enforce in POST /members when member invite is added.
  maxMembersPerTenant: number

  // Page revision history a member can see/restore, in days. Infinity = keep all.
  // Enforced at read time in the revisions routes (free tiers expose only recent
  // history; older revisions are hidden and not restorable).
  historyRetentionDays: number

  // Total CONFIRMED attachment storage per tenant, in bytes. Infinity = unlimited.
  // Enforced at presign time by summing confirmed sizes; see that handler for the
  // count+insert race note.
  maxStorageBytes: number
}

const GB = 1_000_000_000

// Canonical plan → entitlement table. Add rows here when new plans are introduced.
// Enterprise tiers with custom limits override this at runtime (future work).
//
// Pricing philosophy: anonymous share-link collaboration is FREE on every plan
// (it is what makes the product spread). Paid tiers monetize team SCALE — more
// spaces, longer history, more storage, more members.
const PLANS: Record<string, Entitlements> = {
  free: { guestAccess: true, maxSpaces: 3,        maxMembersPerTenant: 5,  historyRetentionDays: 7,        maxStorageBytes: 1 * GB   },
  pro:  { guestAccess: true, maxSpaces: Infinity, maxMembersPerTenant: 50, historyRetentionDays: Infinity, maxStorageBytes: 100 * GB },
}

export function resolveEntitlements(plan: string): Entitlements {
  return PLANS[plan] ?? PLANS['free']!
}
