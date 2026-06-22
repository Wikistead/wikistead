// Entitlement resolution: the single source of plan-conditional logic.
// "if (plan === ...)" is prohibited in routes, services, and collab. All plan
// limits and feature flags resolve through resolveEntitlements(plan).
//
// EDITION MODEL (see ADR-015). Plan limits apply ONLY to the managed Cloud.
// Self-hosted Community/Enterprise builds register NOTHING and therefore resolve
// to UNLIMITED — Community First is guaranteed by construction, with no env flag
// and no config (the original `WIKISTEAD_CLOUD` runtime gate was rejected: a
// missing env there fails OPEN to unlimited = a silent revenue bypass).
//
// The Cloud entrypoint calls registerEntitlementsResolver(cloudEntitlements) and
// assertEntitlementsResolverRegistered() at boot. If a Cloud build forgets to
// register, boot FAILS (fail-closed) instead of silently running unlimited.

export interface Entitlements {
  // Gate for share-link ISSUANCE only. Anonymous collaboration is the product's
  // viral hook and is FREE on every plan, so this is true everywhere; the flag
  // stays so a future restricted tier can disable issuance in one place. collab
  // onAuthenticate does NOT check this — existing links survive a downgrade.
  guestAccess: boolean

  // PRIMARY paid lever: billable members (seats). Infinity = pay-per-seat / no cap.
  // TODO(phase: auth): enforce in POST /members when member invite is added.
  maxSeats: number

  // Generous on purpose (NOT a paid lever): spaces don't gate the viral hook.
  // The POST /spaces gate stays but is inert while this is Infinity.
  maxSpaces: number

  // Page revision history a member can see/restore, in days. Infinity = keep all.
  // Enforced at read time in the revisions routes (limited tiers expose only the
  // recent window; older revisions are hidden and not restorable).
  historyRetentionDays: number

  // Total CONFIRMED attachment storage per tenant, in bytes. Infinity = no hard
  // cap (Cloud Pro uses metered overage instead). Enforced at presign time.
  maxStorageBytes: number

  // Custom branding (tenant/space accent + tenant logo). A Pro value lever:
  // self-host is unlimited (Community First), Cloud free is off, Cloud Pro is on.
  // The server gates WRITES (403) and STRIPS branding on READ when false, so a
  // downgrade cleanly reverts to the default look while stored values survive for a
  // re-upgrade. Personal light/dark theme is NOT gated (always available).
  branding: boolean
}

// Self-host / Community edition: never plan-limited.
export const UNLIMITED: Entitlements = {
  guestAccess: true,
  maxSeats: Infinity,
  maxSpaces: Infinity,
  historyRetentionDays: Infinity,
  maxStorageBytes: Infinity,
  branding: true,
}

const GB = 1_000_000_000

// Cloud plan table. PLACEHOLDER VALUES — the specific numbers, the number of
// tiers (free/pro now; Team later), and pricing are NOT decided; they are set to
// rough norms so enforcement can be wired and tested. Finalize before launch.
// TODO(business): finalize limits + pricing + tier count; map to CE/EE/Cloud
//   (Cloud's future top tier is "Team", NOT "Enterprise" — that word is reserved
//   for the self-host proprietary edition). See ADR-015.
// TODO(billing): Pro storage is Infinity = metered overage. Before launch it
//   needs a soft cap + usage alerts so a tenant cannot rack up a silent runaway
//   bill (the classic metered-billing trap).
// TODO(open-core): these Cloud numbers are a commercial concern; move CLOUD_PLANS
//   into an EE/Cloud package when one exists, so the AGPL CE package stays clean.
const CLOUD_PLANS: Record<string, Entitlements> = {
  free: { guestAccess: true, maxSeats: 5,        maxSpaces: Infinity, historyRetentionDays: 7,        maxStorageBytes: 5 * GB,     branding: false },
  pro:  { guestAccess: true, maxSeats: Infinity, maxSpaces: Infinity, historyRetentionDays: Infinity, maxStorageBytes: Infinity, branding: true },
  // The Cloud top tier is "team" (contact-sales / invoiced) — NOT "enterprise",
  // which ADR-015 reserves for the self-host proprietary edition. Mirrors Pro for
  // now; its differentiators (SCIM, audit log) are post-launch and add flags here.
  team: { guestAccess: true, maxSeats: Infinity, maxSpaces: Infinity, historyRetentionDays: Infinity, maxStorageBytes: Infinity, branding: true },
}

// The Cloud resolver. Registered by the Cloud entrypoint; exported so tests can
// exercise the limited behavior directly.
export function cloudEntitlements(plan: string): Entitlements {
  return CLOUD_PLANS[plan] ?? CLOUD_PLANS['free']!
}

// ── Resolver registry (same register/get pattern as @wikistead/hooks) ───────
// Default resolver = UNLIMITED. Self-host registers nothing. Cloud registers
// cloudEntitlements. resolveEntitlements' only input stays `plan` — the edition
// is decided once, at composition time, not per call and not via env branches.

let _resolver: (plan: string) => Entitlements = () => UNLIMITED
let _registered = false

export function registerEntitlementsResolver(fn: (plan: string) => Entitlements): void {
  _resolver = fn
  _registered = true
}

// Cloud entrypoint MUST call this at boot. Fail-closed: if nothing was
// registered the resolver is still UNLIMITED, so rather than silently run a
// revenue bypass we refuse to start. Self-host/CE never calls this.
export function assertEntitlementsResolverRegistered(): void {
  if (!_registered) {
    throw new Error(
      'entitlements: no resolver registered — refusing to start a managed deployment that would run UNLIMITED. ' +
        'The Cloud entrypoint must call registerEntitlementsResolver(cloudEntitlements).',
    )
  }
}

export function resolveEntitlements(plan: string): Entitlements {
  return _resolver(plan)
}

// Test-only: restore the default (UNLIMITED) resolver so registry state cannot
// leak between tests.
export function resetEntitlementsResolver(): void {
  _resolver = () => UNLIMITED
  _registered = false
}
