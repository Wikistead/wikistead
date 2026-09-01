<!--
  AUTO-GENERATED — DO NOT EDIT BY HAND.
  Source: packages/entitlements/src/catalog.ts (LEVER_CATALOG).
  Regenerate: pnpm docs:gen   ·   Verify (CI): pnpm docs:check
  This is the "code is truth" levers reference fed to the docs SSG.
-->

# What each plan includes

Each row is one feature or limit a plan can include. Self-hosted
Community/Enterprise builds have every one of them enabled or unlimited;
the per-tier Cloud values are published separately.

| Feature | Edition | What it controls | Self-host (Community) | Enforced at | Downgrade |
|---|---|---|---|---|---|
| **Guest access** (`guestAccess`) | CE | Issuing anonymous share links for real-time collaboration. Free on every plan. | Enabled | share-link issuance (already-issued links keep working after a downgrade; revoking a link still works as normal) | issuance gated; previously issued links keep working |
| **Member seats** (`maxSeats`) | CE | Billable members (seats). The main limit that separates plans. | Unlimited | invite acceptance (creating an invite only warns) | over-cap blocks new invites; never removes existing members (the freeze deactivates newest-first, and is reversible) |
| **Spaces** (`maxSpaces`) | CE | Number of spaces. Generous on purpose — not something plans are meant to limit. | Unlimited | POST /spaces (inert while unlimited) | over-cap blocks new spaces; existing spaces are kept |
| **Page templates** (`maxTemplates`) | CE | Reusable page templates a workspace may hold. Unlimited on all plans. | Unlimited | POST /templates (inert while unlimited) | over-cap blocks new templates; existing templates are kept |
| **Outbound webhooks** (`webhooks`) | CE | Event-notification webhooks. On for self-hosted builds; on Cloud, Personal and up. | Enabled | POST /webhooks (creation) | creation blocked; already-created hooks keep delivering |
| **History retention** (`historyRetentionDays`) | CE | Page revision history a member can see and restore, in days. | Unlimited | revisions read (retention cutoff) | older revisions are hidden and not restorable; nothing is deleted |
| **Storage** (`maxStorageBytes`) | CE | Total confirmed attachment storage per workspace, in bytes. | Unlimited | when an upload is authorized (plus metered overage where configured) | new uploads freeze; existing attachments are kept |
| **Custom branding** (`branding`) | CE | Workspace/space accent color and workspace logo. Personal light/dark theme is never gated. | Enabled | branding write (403) + strip on read | reverts to the default look; the stored value survives for a re-upgrade |
| **API access** (`apiAccess`) | CE | Issuance of API keys. | Enabled | POST /api-keys | issuance gated; existing keys keep working |
| **Custom domain** (`customDomain`) | CE | A custom domain for the workspace, such as docs.acme.com. | Enabled | custom-domain add/verify | revoked on loss — the domain stops serving the workspace and is removed from routing |
| **SCIM provisioning** (`scim`) | EE | SCIM directory provisioning — tokens + endpoints (EE). | Enabled | SCIM token issuance + /scim/v2 endpoints | gated; EE-only |
| **AI assists** (`aiFeatures`) | CE | AI features (summarize, ask the knowledge base, etc.). Also requires a configured AI provider (bring your own key) — this switch says whether the plan includes AI; the provider is set up per deployment. | Enabled | the AI feature gate (must be both included in the plan and configured) | gated; non-destructive (metered soft-cap blocks, keeps content) |
| **AI token allowance** (`aiTokenAllowance`) | CE | Metered AI-token soft cap per billing window. New AI calls are refused once the window usage reaches it; existing content is untouched and an alert fires before the wall. | Unlimited | each AI call (usage for the billing window is checked before a billable completion) | new AI calls soft-cap when over the lower allowance; existing content/usage kept |
| **SAML SSO** (`samlSso`) | EE | Workspace SAML single sign-on — configuration + login (EE). | Enabled | workspace SAML config + /auth/saml | gated; EE-only (SAML sign-in is available only while the plan includes it) |
| **Managed email sender** (`managedEmail`) | CE | Notification email is sent through the managed provider instead of self-hosted SMTP. | Enabled | whenever an email is sent (immediate sends and queued deliveries) | sending falls back to the self-hosted default (SMTP, or nothing if none is configured); the feature itself is never gated |
| **Compliance audit log** (`auditLog`) | EE | Durable, tamper-evident audit log of permission and compliance operations (EE). | Enabled | when an auditable operation is recorded (skipped when disabled) | gated; EE-only (no audit ledger written for CE/free) |
| **Access Transparency** (`accessTransparency`) | EE | Discloses operator break-glass accesses to the workspace — a tamper-evident, per-workspace view of the sealed operator log (EE). | Enabled | the admin Transparency screen and its API (GET /admin/transparency + /verify) | gated; rows retained and hidden |
| **Page analytics (who-viewed)** (`analytics`) | EE | Per-viewer page analytics: members named in a roster, guests/anonymous aggregated (EE). | Enabled | when views are collected, and at the dashboard (collection itself is gated — no history accrues for CE/free plans) | gated; collection stops, retained rows follow the retention/erasure policy |
| **User/third-party macros** (`userMacros`) | CE | Whether the workspace may run community/third-party macros. Also needs a workspace-admin allowlist; a macro can never grant itself access. Built-in macros are always allowed. | Enabled | the macro permission gate (plan AND admin allowlist) | gated; built-in macros keep working |
| **MCP write tools** (`mcpWrite`) | CE | Whether the workspace may use MCP write tools (create/edit/publish via the connector). Read tools are on every plan; only writing is gated (Cloud/EE). Permissions still apply to each page. | Enabled | MCP write-tool calls (checked together with the token write scope) | write tools gated; read tools + previously-created pages keep working |
| **Space edit share-links** (`spaceEditLink`) | CE | Whether the workspace may issue a space-wide edit share-link (an anonymous collaborative wiki). Cloud paid tiers only; self-host unlimited. Permissions still apply to every page the link reaches. | Enabled | share-link issuance (space-wide edit links); existing links unaffected | issuance gated; already-issued links keep working |
| **Custom roles** (`customRoles`) | CE | Whether the workspace may define and assign custom roles — named bundles of capabilities (view/comment/edit/publish/delete/share/settings/moderate). Built-in roles are free on every plan; a custom role only chooses which of the same permissions to grant. | Enabled | role define/edit/delete and assignment (workspace-admin routes) | defining/assigning gated; permissions already granted through a role keep working |
| **API rate limit** (`apiRateLimit`) | CE | API-key request rate per window — perKey (fairness between keys) and perTenant (ceiling across all keys); whichever is stricter applies. | perKey unlimited, perTenant unlimited | per-request API-key limiter | resolved per request; a lower limit takes effect immediately (429 + Retry-After) |
