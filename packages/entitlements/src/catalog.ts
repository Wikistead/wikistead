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
  // #693: which EDITION owns this lever's ENFORCEMENT BYTES. 'ee' means the code that gates on it
  // must live in the private overlay — an entitlement check in the CE tree is #688's defect (locked
  // by plan, bytes public: the audit ledger sat that way for eight months). Optional with 'ce' as the
  // default so the common case stays unannotated; a lint (check-ee-lever-placement.mjs) derives its
  // deny-set from the 'ee' rows, so a sixth EE lever is guarded by being declared, not remembered.
  edition?: 'ce' | 'ee'
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
    // Where the seat cap actually REFUSES, which is not where an invite is created. Creating one only
    // warns (`invites.ts:129` returns `seatWarning`); the cap is enforced when the invitee ACCEPTS
    // (`invites.ts:387` — 402 `seat_limit`), under the per-tenant lock, because that is the moment a
    // seat is taken. Naming the create route sends the next reader to the branch that lets it through.
    enforcedAt: 'invite acceptance (creating an invite only warns)',
    downgrade: 'over-cap blocks new invites; never removes existing members (#131 freeze deactivates newest-first, reversible)',
  },
  maxSpaces: {
    title: 'Spaces',
    summary: 'Number of spaces. Generous on purpose — spaces do not gate the viral hook (not a paid lever).',
    unit: 'count',
    enforcedAt: 'POST /spaces (inert while unlimited)',
    downgrade: 'over-cap blocks new spaces; existing spaces are kept',
  },
  maxTemplates: {
    title: 'Page templates',
    summary: 'Reusable page templates a tenant may hold. A knowledge-first primitive, not a paid lever — unlimited on all plans.',
    unit: 'count',
    enforcedAt: 'POST /templates (inert while unlimited)',
    downgrade: 'over-cap blocks new templates; existing templates are kept',
  },
  webhooks: {
    title: 'Outbound webhooks',
    summary: 'Event-notification webhooks. Self-host on (Community First); Cloud is Personal and up.',
    unit: 'boolean',
    enforcedAt: 'POST /webhooks (creation)',
    downgrade: 'creation blocked; already-created hooks keep delivering',
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
    edition: 'ee',
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
  aiTokenAllowance: {
    title: 'AI token allowance',
    summary: 'Metered AI-token soft cap per billing window (#128 / ADR-082). New AI calls are refused once the window usage reaches it; existing content is untouched and an alert fires before the wall.',
    unit: 'count',
    enforcedAt: 'AI call (decideAllowance over usage_counters before a billable completion)',
    downgrade: 'new AI calls soft-cap when over the lower allowance; existing content/usage kept (ADR-082/072)',
  },
  samlSso: {
    edition: 'ee',
    title: 'SAML SSO',
    summary: 'Tenant SAML single sign-on — config + login (#135 / ADR-067, EE).',
    unit: 'boolean',
    enforcedAt: 'tenant SAML config + /auth/saml',
    downgrade: 'gated; EE-only (the SP loads only under this entitlement)',
  },
  managedEmail: {
    title: 'Managed email sender',
    summary: 'Notification email rides the managed provider driver instead of self-hosted SMTP (#547 / ADR-196 §7).',
    unit: 'boolean',
    enforcedAt: 'email driver resolution (request path + outbox drain)',
    downgrade: 'transport falls back to the CE default (SMTP/no-op); the feature itself is CE and never gated',
  },
  auditLog: {
    edition: 'ee',
    title: 'Compliance audit log',
    summary: 'Durable, hash-chained audit ledger of authz/compliance operations (#134 #177 / ADR-070, EE).',
    unit: 'boolean',
    enforcedAt: 'audit outbox enqueue (skipped when false)',
    downgrade: 'gated; EE-only (no audit ledger written for CE/free)',
  },
  accessTransparency: {
    edition: 'ee',
    title: 'Access Transparency',
    summary: 'Tenant-facing disclosure of operator break-glass accesses — a per-tenant, hash-chained projection of the sealed operator ledger (#435 / ADR-169, EE).',
    unit: 'boolean',
    enforcedAt: 'GET /admin/transparency (+ /verify) entitlement gate',
    downgrade: 'gated; rows retained and hidden (the #401 convention)',
  },
  analytics: {
    edition: 'ee',
    title: 'Page analytics (who-viewed)',
    summary: 'Per-viewer page analytics: members named in a roster, guests/anonymous aggregated (#464 / ADR-175, EE).',
    unit: 'boolean',
    enforcedAt: 'collection enqueue + dashboard (collection itself is gated — no history for CE/free)',
    downgrade: 'gated; collection stops, retained rows follow the retention/erasure policy',
  },
  userMacros: {
    title: 'User/third-party macros',
    summary: 'Whether the tenant may run non-first-party macros (#93 / ADR-073). Requires this AND a tenant-admin allowlist; macros never self-authorize. First-party always allowed.',
    unit: 'boolean',
    enforcedAt: 'host-mediated macro permission gate (entitlement AND admin allowlist)',
    downgrade: 'gated; first-party macros keep working',
  },
  mcpWrite: {
    title: 'MCP write tools',
    summary: 'Whether the tenant may use MCP WRITE tools (create/edit/publish via the connector, #311 / ADR-131). MCP read tools are all-plans; only write is gated (write = Cloud/EE,). OpenFGA still gates each resource.',
    unit: 'boolean',
    enforcedAt: 'the /mcp tools/call handler (write-scope tools) — checked alongside the token write scope',
    downgrade: 'write tools gated; read tools + previously-created pages keep working',
  },
  spaceEditLink: {
    title: 'Space edit share-links',
    summary: 'Whether the tenant may ISSUE a space-wide EDIT share-link (anonymous collaborative wiki, #274 / ADR-135). Cloud = paid tiers only; self-host unlimited. OpenFGA still gates every page the link reaches.',
    unit: 'boolean',
    enforcedAt: 'share-link issuance (createShareLink, space+edit) — 402 with a static reason; existing links unaffected',
    downgrade: 'issuance gated; already-issued links keep working (revocation policy: #127)',
  },
  customRoles: {
    title: 'Custom roles',
    summary: 'Whether the tenant may DEFINE and ASSIGN custom roles — named bundles of atomic capabilities (view/comment/edit/publish/delete/share/settings/moderate; #420 / ADR-164). Built-in roles are free on every plan. OpenFGA stays the single authz truth: a role only chooses which fixed-relation tuples to write.',
    unit: 'boolean',
    enforcedAt: 'role define/edit/delete + assignment write-paths (tenant-admin routes) — 403 entitlementDenied',
    downgrade: 'defining/assigning gated; already-expanded grants are plain FGA tuples and keep working',
  },
  apiRateLimit: {
    title: 'API rate limit',
    summary: 'Authenticated API-key request rate per window — perKey (per-key fairness) and perTenant (all-keys ceiling), evaluated AND (the stricter trips first → 429) (#175 / ADR-063).',
    unit: 'rate',
    enforcedAt: 'per-request API-key limiter (Valkey)',
    downgrade: 'resolved per request; a lower limit takes effect immediately (429 + Retry-After)',
  },
}
