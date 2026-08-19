<!--
  AUTO-GENERATED — DO NOT EDIT BY HAND.
  Source: packages/entitlements/src/catalog.ts (LEVER_CATALOG).
  Regenerate: pnpm docs:gen   ·   Verify (CI): pnpm docs:check
  This is the "code is truth" levers reference fed to the docs SSG (ADR-080).
-->

# Entitlement levers

Every paid lever is an `Entitlements` field resolved in one place
(`resolveEntitlements(plan)`). Self-hosted Community/Enterprise builds are
`UNLIMITED` by construction; the per-tier Cloud values are published
separately. This page is generated from the code (`LEVER_CATALOG`).

| Lever | Edition | What it gates | Self-host (Community) | Enforced at | Downgrade |
|---|---|---|---|---|---|
| **Guest access** (`guestAccess`) | CE | Issuance of anonymous share links (the real-time collaboration hook). Free on every plan; the flag stays so a future restricted tier can disable issuance in one place. | Enabled | share-link issuance (collab onAuthenticate does NOT check it — existing links survive a downgrade) | issuance gated; previously issued links keep working |
| **Member seats** (`maxSeats`) | CE | Billable members (seats). The primary paid lever. | Unlimited | invite acceptance (creating an invite only warns) | over-cap blocks new invites; never removes existing members (the freeze deactivates newest-first, and is reversible) |
| **Spaces** (`maxSpaces`) | CE | Number of spaces. Generous on purpose — spaces do not gate the viral hook (not a paid lever). | Unlimited | POST /spaces (inert while unlimited) | over-cap blocks new spaces; existing spaces are kept |
| **Page templates** (`maxTemplates`) | CE | Reusable page templates a tenant may hold. A knowledge-first primitive, not a paid lever — unlimited on all plans. | Unlimited | POST /templates (inert while unlimited) | over-cap blocks new templates; existing templates are kept |
| **Outbound webhooks** (`webhooks`) | CE | Event-notification webhooks. Self-host on (Community First); Cloud is Personal and up. | Enabled | POST /webhooks (creation) | creation blocked; already-created hooks keep delivering |
| **History retention** (`historyRetentionDays`) | CE | Page revision history a member can see and restore, in days. | Unlimited | revisions read (retention cutoff) | older revisions are hidden and not restorable; nothing is deleted |
| **Storage** (`maxStorageBytes`) | CE | Total confirmed attachment storage per tenant, in bytes. | Unlimited | attachment presign (+ metered overage where configured) | new uploads freeze; existing attachments are kept |
| **Custom branding** (`branding`) | CE | Tenant/space accent + tenant logo. Personal light/dark theme is never gated. | Enabled | branding write (403) + strip on read | reverts to the default look; the stored value survives for a re-upgrade |
| **API access** (`apiAccess`) | CE | Issuance of API keys. | Enabled | POST /api-keys | issuance gated; existing keys keep working |
| **Custom domain** (`customDomain`) | CE | A tenant custom domain such as docs.acme.com. | Enabled | custom-domain add/verify | three-point revoke on loss — row + host→tenant map + cert |
| **SCIM provisioning** (`scim`) | EE | SCIM directory provisioning — tokens + endpoints (EE). | Enabled | SCIM token issuance + /scim/v2 endpoints | gated; EE-only |
| **AI assists** (`aiFeatures`) | CE | AI features (summarize / ask-KB / etc.). Also requires a registered AIProvider (BYOK) — this is the PLAN lever, the provider is the deployment switch. | Enabled | AI capability gate (entitled AND configured) | gated; non-destructive (metered soft-cap blocks, keeps content) |
| **AI token allowance** (`aiTokenAllowance`) | CE | Metered AI-token soft cap per billing window. New AI calls are refused once the window usage reaches it; existing content is untouched and an alert fires before the wall. | Unlimited | AI call (decideAllowance over usage_counters before a billable completion) | new AI calls soft-cap when over the lower allowance; existing content/usage kept |
| **SAML SSO** (`samlSso`) | EE | Tenant SAML single sign-on — config + login (EE). | Enabled | tenant SAML config + /auth/saml | gated; EE-only (the SP loads only under this entitlement) |
| **Managed email sender** (`managedEmail`) | CE | Notification email rides the managed provider driver instead of self-hosted SMTP. | Enabled | email driver resolution (request path + outbox drain) | transport falls back to the CE default (SMTP/no-op); the feature itself is CE and never gated |
| **Compliance audit log** (`auditLog`) | EE | Durable, hash-chained audit ledger of authz/compliance operations (EE). | Enabled | audit outbox enqueue (skipped when false) | gated; EE-only (no audit ledger written for CE/free) |
| **Access Transparency** (`accessTransparency`) | EE | Tenant-facing disclosure of operator break-glass accesses — a per-tenant, hash-chained projection of the sealed operator ledger (EE). | Enabled | GET /admin/transparency (+ /verify) entitlement gate | gated; rows retained and hidden |
| **Page analytics (who-viewed)** (`analytics`) | EE | Per-viewer page analytics: members named in a roster, guests/anonymous aggregated (EE). | Enabled | collection enqueue + dashboard (collection itself is gated — no history for CE/free) | gated; collection stops, retained rows follow the retention/erasure policy |
| **User/third-party macros** (`userMacros`) | CE | Whether the tenant may run non-first-party macros. Requires this AND a tenant-admin allowlist; macros never self-authorize. First-party always allowed. | Enabled | host-mediated macro permission gate (entitlement AND admin allowlist) | gated; first-party macros keep working |
| **MCP write tools** (`mcpWrite`) | CE | Whether the tenant may use MCP WRITE tools (create/edit/publish via the connector). MCP read tools are all-plans; only write is gated (write = Cloud/EE). OpenFGA still gates each resource. | Enabled | the /mcp tools/call handler (write-scope tools) — checked alongside the token write scope | write tools gated; read tools + previously-created pages keep working |
| **Space edit share-links** (`spaceEditLink`) | CE | Whether the tenant may ISSUE a space-wide EDIT share-link (anonymous collaborative wiki). Cloud = paid tiers only; self-host unlimited. OpenFGA still gates every page the link reaches. | Enabled | share-link issuance (createShareLink, space+edit) — 402 with a static reason; existing links unaffected | issuance gated; already-issued links keep working |
| **Custom roles** (`customRoles`) | CE | Whether the tenant may DEFINE and ASSIGN custom roles — named bundles of atomic capabilities (view/comment/edit/publish/delete/share/settings/moderate). Built-in roles are free on every plan. OpenFGA stays the single authz truth: a role only chooses which fixed-relation tuples to write. | Enabled | role define/edit/delete + assignment write-paths (tenant-admin routes) — 403 entitlementDenied | defining/assigning gated; already-expanded grants are plain FGA tuples and keep working |
| **API rate limit** (`apiRateLimit`) | CE | Authenticated API-key request rate per window — perKey (per-key fairness) and perTenant (all-keys ceiling), evaluated AND (the stricter trips first → 429). | perKey unlimited, perTenant unlimited | per-request API-key limiter (Valkey) | resolved per request; a lower limit takes effect immediately (429 + Retry-After) |
