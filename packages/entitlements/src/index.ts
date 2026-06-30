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

  // API key access (#126 / ADR-063). Gates POST /api-keys creation. A Pro value lever:
  // self-host on (Community First), Cloud free off, Cloud Pro/Team on. WHICH plans is a business
  // placeholder; the gate reads this resolved boolean (entitlement⟂authz separation).
  apiAccess: boolean

  // Custom domain (#123 / ADR-065). Gates adding/verifying a tenant custom domain (docs.acme.com).
  // A Pro value lever: self-host on (Community First), Cloud free off, Cloud Pro/Team on. WHICH plans
  // is a business placeholder; the gate reads this resolved boolean. Losing it revokes the domain
  // (ADR-064 downgrade: three-point revoke — the entitlement is the one place this is decided).
  customDomain: boolean

  // SCIM provisioning (#134 / ADR-070): gates the SCIM token + endpoints (EE). Self-host EE on;
  // Cloud top tier only — business placeholder. The provider/endpoints load only under this flag.
  scim: boolean

  // Compliance audit log (#134 #177 / ADR-070): gates writing the durable, hash-chained audit_log
  // (the transactional outbox enqueue is skipped when false). EE (self-host EE on; Cloud top tier
  // only — business placeholder). CE/free tenants generate no audit ledger.
  auditLog: boolean

  // AI assists (#130 / ADR-077): gates the AI features (summarize/ask-KB/etc.). OFF by default
  // except self-host UNLIMITED; AI is also OFF unless an AIProvider is registered (BYOK) — this
  // flag is the PLAN lever, the registered provider is the deployment switch. Business placeholder.
  aiFeatures: boolean

  // SAML SSO (#135 / ADR-067): gates tenant SAML config + login. EE tier (self-host EE on;
  // Cloud = top tier only — business placeholder). CE bundles no SAML; the provider loads only
  // under this entitlement. The gate reads this resolved boolean (entitlement⟂authz).
  samlSso: boolean

  // API-key REQUEST rate limit (#175 / ADR-063): max authenticated API-key requests per fixed
  // window — `perKey` (fairness per key) and `perTenant` (the all-keys-combined tenant ceiling),
  // evaluated AND (the stricter trips first → 429). Infinity = no limit (self-host: the limiter is
  // skipped entirely, zero overhead). Resolved PER REQUEST so a downgrade takes effect immediately.
  // The numbers are a business placeholder. Window = API_RATE_LIMIT_WINDOW_S (env, default 60).
  apiRateLimit: { perKey: number; perTenant: number }

  // Tenant macro LEVEL CAP (#93 / ADR-073): the highest MacroTier standard layer the tenant may
  // persist. The host auto-demotes to min(lowest-representable, this cap) — server is the fortress
  // (persist-time normalize). 'directive' = no cap (top). Self-host UNLIMITED = 'directive'; a
  // restricted tier could cap at 'gfm'/'commonmark' — business placeholder. entitlement⟂authz.
  macroLevelCap: MacroLevelCap

  // User/third-party macros (#93 / ADR-073 + #075/#076): may the tenant run NON-first-party macros?
  // Requires this AND a tenant-admin allowlist (host-mediated gate; macros never self-authorize).
  // first-party macros ignore this. Self-host UNLIMITED on; Cloud = business placeholder.
  userMacros: boolean
}

// MacroTier standard layers, lowest (most portable) → highest (least portable); the level cap above
// names the ceiling. Mirrors StandardLayer in the editor macro registry (kept in sync by review).
export type MacroLevelCap = 'commonmark' | 'gfm' | 'directive'

// Self-host / Community edition: never plan-limited.
export const UNLIMITED: Entitlements = {
  guestAccess: true,
  maxSeats: Infinity,
  maxSpaces: Infinity,
  historyRetentionDays: Infinity,
  maxStorageBytes: Infinity,
  branding: true,
  apiAccess: true,
  customDomain: true,
  samlSso: true,
  scim: true,
  auditLog: true,
  aiFeatures: true,
  apiRateLimit: { perKey: Infinity, perTenant: Infinity },
  macroLevelCap: 'directive',
  userMacros: true,
}

// NOTE (ADR-069 / #132): the Cloud plan table (`CLOUD_PLANS`) and its resolver
// (`cloudEntitlements`) have MOVED to the proprietary `@wikistead/entitlements-cloud`
// package, so this AGPL CE package carries NO commercial Cloud config. This package keeps
// only the edition-neutral seam: the `Entitlements` interface, `UNLIMITED`, the resolver
// registry, and `resolveEntitlements`. The Cloud composition root imports cloudEntitlements
// from that package and registers it at boot (ADR-015 wiring unchanged).

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

// "Code is truth" docs (#139 / ADR-080 doc↔code linkage): the lever catalog and
// its Markdown generator. CE-only (never imports the Cloud plan table).
export { LEVER_CATALOG, type LeverDoc, type LeverUnit } from './catalog.js'
export { renderEntitlementsMarkdown } from './gen-doc.js'

// Metered-usage soft-cap + alert decision core (#128 / ADR-082).
export { decideAllowance, crossedThresholds, type AllowanceDecision } from './metering.js'
