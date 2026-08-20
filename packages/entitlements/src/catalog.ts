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
    summary: 'Issuing anonymous share links for real-time collaboration. Free on every plan.',
    unit: 'boolean',
    enforcedAt: 'share-link issuance (existing links are never re-checked, so they survive a downgrade)',
    downgrade: 'issuance gated; previously issued links keep working',
  },
  maxSeats: {
    title: 'Member seats',
    summary: 'Billable members (seats). The main thing paid plans are priced on.',
    unit: 'count',
    // Where the seat cap actually REFUSES, which is not where an invite is created. Creating one only
    // warns (`invites.ts:129` returns `seatWarning`); the cap is enforced when the invitee ACCEPTS
    // (`invites.ts:387` — 402 `seat_limit`), under the per-tenant lock, because that is the moment a
    // seat is taken. Naming the create route sends the next reader to the branch that lets it through.
    enforcedAt: 'invite acceptance (creating an invite only warns)',
    downgrade: 'over-cap blocks new invites; never removes existing members (the freeze deactivates newest-first, and is reversible)',
  },
  maxSpaces: {
    title: 'Spaces',
    summary: 'Number of spaces. Generous on purpose — not something plans are meant to limit.',
    unit: 'count',
    enforcedAt: 'POST /spaces (inert while unlimited)',
    downgrade: 'over-cap blocks new spaces; existing spaces are kept',
  },
  maxTemplates: {
    title: 'Page templates',
    summary: 'Reusable page templates a workspace may hold. Unlimited on all plans.',
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
    summary: 'Total confirmed attachment storage per workspace, in bytes.',
    unit: 'bytes',
    enforcedAt: 'attachment presign (+ metered overage where configured)',
    downgrade: 'new uploads freeze; existing attachments are kept',
  },
  branding: {
    title: 'Custom branding',
    summary: 'Workspace/space accent color and workspace logo. Personal light/dark theme is never gated.',
    unit: 'boolean',
    enforcedAt: 'branding write (403) + strip on read',
    downgrade: 'reverts to the default look; the stored value survives for a re-upgrade',
  },
  apiAccess: {
    title: 'API access',
    summary: 'Issuance of API keys.',
    unit: 'boolean',
    enforcedAt: 'POST /api-keys',
    downgrade: 'issuance gated; existing keys keep working',
  },
  customDomain: {
    title: 'Custom domain',
    summary: 'A custom domain for the workspace, such as docs.acme.com.',
    unit: 'boolean',
    enforcedAt: 'custom-domain add/verify',
    downgrade: 'fully revoked on loss — the domain, its routing, and its certificate are all removed',
  },
  scim: {
    edition: 'ee',
    title: 'SCIM provisioning',
    summary: 'SCIM directory provisioning — tokens + endpoints (EE).',
    unit: 'boolean',
    enforcedAt: 'SCIM token issuance + /scim/v2 endpoints',
    downgrade: 'gated; EE-only',
  },
  aiFeatures: {
    title: 'AI assists',
    summary: 'AI features (summarize, ask the knowledge base, etc.). Also requires a configured AI provider (bring your own key) — this switch says whether the plan includes AI; the provider is set up per deployment.',
    unit: 'boolean',
    enforcedAt: 'the AI feature gate (must be both included in the plan and configured)',
    downgrade: 'gated; non-destructive (metered soft-cap blocks, keeps content)',
  },
  aiTokenAllowance: {
    title: 'AI token allowance',
    summary: 'Metered AI-token soft cap per billing window. New AI calls are refused once the window usage reaches it; existing content is untouched and an alert fires before the wall.',
    unit: 'count',
    enforcedAt: 'each AI call (usage for the billing window is checked before a billable completion)',
    downgrade: 'new AI calls soft-cap when over the lower allowance; existing content/usage kept',
  },
  samlSso: {
    edition: 'ee',
    title: 'SAML SSO',
    summary: 'Workspace SAML single sign-on — configuration + login (EE).',
    unit: 'boolean',
    enforcedAt: 'workspace SAML config + /auth/saml',
    downgrade: 'gated; EE-only (SAML sign-in is available only while the plan includes it)',
  },
  managedEmail: {
    title: 'Managed email sender',
    summary: 'Notification email is sent through the managed provider instead of self-hosted SMTP.',
    unit: 'boolean',
    enforcedAt: 'whenever an email is sent (immediate sends and queued deliveries)',
    downgrade: 'transport falls back to the CE default (SMTP/no-op); the feature itself is CE and never gated',
  },
  auditLog: {
    edition: 'ee',
    title: 'Compliance audit log',
    summary: 'Durable, tamper-evident audit log of permission and compliance operations (EE).',
    unit: 'boolean',
    enforcedAt: 'when an auditable operation is recorded (skipped when disabled)',
    downgrade: 'gated; EE-only (no audit ledger written for CE/free)',
  },
  accessTransparency: {
    edition: 'ee',
    title: 'Access Transparency',
    summary: 'Discloses operator break-glass accesses to the workspace — a tamper-evident, per-workspace view of the sealed operator log (EE).',
    unit: 'boolean',
    enforcedAt: 'the admin Transparency screen and its API (GET /admin/transparency + /verify)',
    downgrade: 'gated; rows retained and hidden',
  },
  analytics: {
    edition: 'ee',
    title: 'Page analytics (who-viewed)',
    summary: 'Per-viewer page analytics: members named in a roster, guests/anonymous aggregated (EE).',
    unit: 'boolean',
    enforcedAt: 'collection enqueue + dashboard (collection itself is gated — no history for CE/free)',
    downgrade: 'gated; collection stops, retained rows follow the retention/erasure policy',
  },
  userMacros: {
    title: 'User/third-party macros',
    summary: 'Whether the workspace may run community/third-party macros. Also needs a workspace-admin allowlist; a macro can never grant itself access. Built-in macros are always allowed.',
    unit: 'boolean',
    enforcedAt: 'the macro permission gate (plan AND admin allowlist)',
    downgrade: 'gated; built-in macros keep working',
  },
  mcpWrite: {
    title: 'MCP write tools',
    summary: 'Whether the workspace may use MCP write tools (create/edit/publish via the connector). Read tools are on every plan; only writing is gated (Cloud/EE). Permissions still apply to each page.',
    unit: 'boolean',
    enforcedAt: 'MCP write-tool calls (checked together with the token write scope)',
    downgrade: 'write tools gated; read tools + previously-created pages keep working',
  },
  spaceEditLink: {
    title: 'Space edit share-links',
    summary: 'Whether the workspace may issue a space-wide edit share-link (an anonymous collaborative wiki). Cloud paid tiers only; self-host unlimited. Permissions still apply to every page the link reaches.',
    unit: 'boolean',
    enforcedAt: 'share-link issuance (space-wide edit links); existing links unaffected',
    downgrade: 'issuance gated; already-issued links keep working',
  },
  customRoles: {
    title: 'Custom roles',
    summary: 'Whether the workspace may define and assign custom roles — named bundles of capabilities (view/comment/edit/publish/delete/share/settings/moderate). Built-in roles are free on every plan; a custom role only chooses which of the same permissions to grant.',
    unit: 'boolean',
    enforcedAt: 'role define/edit/delete and assignment (workspace-admin routes)',
    downgrade: 'defining/assigning gated; permissions already granted through a role keep working',
  },
  apiRateLimit: {
    title: 'API rate limit',
    summary: 'API-key request rate per window — perKey (fairness between keys) and perTenant (ceiling across all keys); whichever is stricter applies.',
    unit: 'rate',
    enforcedAt: 'per-request API-key limiter',
    downgrade: 'resolved per request; a lower limit takes effect immediately (429 + Retry-After)',
  },
}
