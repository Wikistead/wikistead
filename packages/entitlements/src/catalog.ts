// "Code is truth" lever catalog (#139 / ADR-080 doc↔code linkage).
//
// This is the machine-readable description of every entitlement lever, used to
// AUTO-GENERATE the levers documentation from code (renderEntitlementsMarkdown,
// fed to the docs SSG). The doc can no longer drift from the code, enforced at
// TWO levels:
//   1. TYPE: `Record<keyof Entitlements, LeverDoc>` — adding a lever to the
//      Entitlements interface is a COMPILE ERROR until it is documented here.
//   2. RUNTIME: a test asserts the catalog keys equal the UNLIMITED keys (catches
//      an interface/UNLIMITED mismatch), and a CI stale-guard fails if the
//      committed generated Markdown differs from this catalog's render.
//
// CE/EE boundary (ADR-080): this catalog and its render are CE-only — they
// describe the levers and their Community (UNLIMITED) behavior + enforcement
// point, and NEVER import the proprietary Cloud plan table (CLOUD_PLANS). The
// per-tier VALUES are generated on the Cloud side from that package.

import type { Entitlements } from './index.js'

export type LeverUnit = 'boolean' | 'days' | 'bytes' | 'count' | 'rate' | 'enum'

export interface LeverDoc {
  // Human title for the lever (docs heading / table row label).
  title: string
  // What the lever gates (one line, generated verbatim into the docs).
  summary: string
  // How the value is interpreted — drives how the generator renders the limit.
  unit: LeverUnit
  // Where the limit is enforced (the single gate; entitlement⟂authz).
  enforcedAt: string
  // What happens on downgrade below the limit (ADR-072 non-destructive behavior).
  downgrade: string
}

// One entry per Entitlements field. The Record<keyof Entitlements, …> constraint
// is the linkage: a new lever cannot ship without a doc entry (compile error).
export const LEVER_CATALOG: Record<keyof Entitlements, LeverDoc> = {
  guestAccess: {
    title: 'Guest access',
    summary: 'Issuance of anonymous share links (the real-time collaboration hook). Free on every plan; the flag stays so a future restricted tier can disable issuance in one place.',
    unit: 'boolean',
    enforcedAt: 'share-link issuance (collab onAuthenticate does NOT check it — existing links survive a downgrade)',
    downgrade: 'issuance gated; previously issued links keep working',
  },
  maxSeats: {
    title: 'Member seats',
    summary: 'Billable members (seats). The primary paid lever.',
    unit: 'count',
    enforcedAt: 'POST /members (invite)',
    downgrade: 'over-cap blocks new invites; never removes existing members (#131 freeze deactivates newest-first, reversible)',
  },
  maxSpaces: {
    title: 'Spaces',
    summary: 'Number of spaces. Generous on purpose — spaces do not gate the viral hook (not a paid lever).',
    unit: 'count',
    enforcedAt: 'POST /spaces (inert while unlimited)',
    downgrade: 'over-cap blocks new spaces; existing spaces are kept',
  },
  historyRetentionDays: {
    title: 'History retention',
    summary: 'Page revision history a member can see and restore, in days.',
    unit: 'days',
    enforcedAt: 'revisions read (retention cutoff)',
    downgrade: 'older revisions are hidden and not restorable; nothing is deleted',
  },
  maxStorageBytes: {
    title: 'Storage',
    summary: 'Total confirmed attachment storage per tenant, in bytes.',
    unit: 'bytes',
    enforcedAt: 'attachment presign (+ metered overage where configured)',
    downgrade: 'new uploads freeze; existing attachments are kept (ADR-064)',
  },
  branding: {
    title: 'Custom branding',
    summary: 'Tenant/space accent + tenant logo. Personal light/dark theme is never gated.',
    unit: 'boolean',
    enforcedAt: 'branding write (403) + strip on read',
    downgrade: 'reverts to the default look; the stored value survives for a re-upgrade',
  },
  apiAccess: {
    title: 'API access',
    summary: 'Issuance of API keys (#126 / ADR-063).',
    unit: 'boolean',
    enforcedAt: 'POST /api-keys',
    downgrade: 'issuance gated; existing keys per ADR-064',
  },
  customDomain: {
    title: 'Custom domain',
    summary: 'A tenant custom domain such as docs.acme.com (#123 / ADR-065).',
    unit: 'boolean',
    enforcedAt: 'custom-domain add/verify',
    downgrade: 'three-point revoke on loss — row + host→tenant map + cert (ADR-064)',
  },
  scim: {
    title: 'SCIM provisioning',
    summary: 'SCIM directory provisioning — tokens + endpoints (#134 / ADR-070, EE).',
    unit: 'boolean',
    enforcedAt: 'SCIM token issuance + /scim/v2 endpoints',
    downgrade: 'gated; EE-only',
  },
  aiFeatures: {
    title: 'AI assists',
    summary: 'AI features (summarize / ask-KB / etc.) (#130 / ADR-077). Also requires a registered AIProvider (BYOK) — this is the PLAN lever, the provider is the deployment switch.',
    unit: 'boolean',
    enforcedAt: 'AI capability gate (entitled AND configured)',
    downgrade: 'gated; non-destructive (metered soft-cap blocks, keeps content)',
  },
  samlSso: {
    title: 'SAML SSO',
    summary: 'Tenant SAML single sign-on — config + login (#135 / ADR-067, EE).',
    unit: 'boolean',
    enforcedAt: 'tenant SAML config + /auth/saml',
    downgrade: 'gated; EE-only (the SP loads only under this entitlement)',
  },
  auditLog: {
    title: 'Compliance audit log',
    summary: 'Durable, hash-chained audit ledger of authz/compliance operations (#134 #177 / ADR-070, EE).',
    unit: 'boolean',
    enforcedAt: 'audit outbox enqueue (skipped when false)',
    downgrade: 'gated; EE-only (no audit ledger written for CE/free)',
  },
  macroLevelCap: {
    title: 'Macro level cap',
    summary: 'The highest MacroTier layer a tenant may persist (#93 / ADR-073). The host auto-demotes to it at persist time (server fortress); directive = no cap.',
    unit: 'enum',
    enforcedAt: 'persist-time normalization (auto-demote to min(lowest-representable, cap))',
    downgrade: 'content normalizes to the cap layer (non-destructive, round-trips where representable)',
  },
  userMacros: {
    title: 'User/third-party macros',
    summary: 'Whether the tenant may run non-first-party macros (#93 / ADR-073). Requires this AND a tenant-admin allowlist; macros never self-authorize. First-party always allowed.',
    unit: 'boolean',
    enforcedAt: 'host-mediated macro permission gate (entitlement AND admin allowlist)',
    downgrade: 'gated; first-party macros keep working',
  },
  apiRateLimit: {
    title: 'API rate limit',
    summary: 'Authenticated API-key request rate per window — perKey (per-key fairness) and perTenant (all-keys ceiling), evaluated AND (the stricter trips first → 429) (#175 / ADR-063).',
    unit: 'rate',
    enforcedAt: 'per-request API-key limiter (Valkey)',
    downgrade: 'resolved per request; a lower limit takes effect immediately (429 + Retry-After)',
  },
}
