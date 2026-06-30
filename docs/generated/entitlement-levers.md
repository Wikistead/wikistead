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

| Lever | What it gates | Self-host (Community) | Enforced at | Downgrade |
|---|---|---|---|---|
| **Guest access** (`guestAccess`) | Issuance of anonymous share links (the real-time collaboration hook). Free on every plan; the flag stays so a future restricted tier can disable issuance in one place. | Enabled | share-link issuance (collab onAuthenticate does NOT check it — existing links survive a downgrade) | issuance gated; previously issued links keep working |
| **Member seats** (`maxSeats`) | Billable members (seats). The primary paid lever. | Unlimited | POST /members (invite) | over-cap blocks new invites; never removes existing members (#131 freeze deactivates newest-first, reversible) |
| **Spaces** (`maxSpaces`) | Number of spaces. Generous on purpose — spaces do not gate the viral hook (not a paid lever). | Unlimited | POST /spaces (inert while unlimited) | over-cap blocks new spaces; existing spaces are kept |
| **History retention** (`historyRetentionDays`) | Page revision history a member can see and restore, in days. | Unlimited | revisions read (retention cutoff) | older revisions are hidden and not restorable; nothing is deleted |
| **Storage** (`maxStorageBytes`) | Total confirmed attachment storage per tenant, in bytes. | Unlimited | attachment presign (+ metered overage where configured) | new uploads freeze; existing attachments are kept (ADR-064) |
| **Custom branding** (`branding`) | Tenant/space accent + tenant logo. Personal light/dark theme is never gated. | Enabled | branding write (403) + strip on read | reverts to the default look; the stored value survives for a re-upgrade |
| **API access** (`apiAccess`) | Issuance of API keys (#126 / ADR-063). | Enabled | POST /api-keys | issuance gated; existing keys per ADR-064 |
| **Custom domain** (`customDomain`) | A tenant custom domain such as docs.acme.com (#123 / ADR-065). | Enabled | custom-domain add/verify | three-point revoke on loss — row + host→tenant map + cert (ADR-064) |
| **SCIM provisioning** (`scim`) | SCIM directory provisioning — tokens + endpoints (#134 / ADR-070, EE). | Enabled | SCIM token issuance + /scim/v2 endpoints | gated; EE-only |
| **AI assists** (`aiFeatures`) | AI features (summarize / ask-KB / etc.) (#130 / ADR-077). Also requires a registered AIProvider (BYOK) — this is the PLAN lever, the provider is the deployment switch. | Enabled | AI capability gate (entitled AND configured) | gated; non-destructive (metered soft-cap blocks, keeps content) |
| **SAML SSO** (`samlSso`) | Tenant SAML single sign-on — config + login (#135 / ADR-067, EE). | Enabled | tenant SAML config + /auth/saml | gated; EE-only (the SP loads only under this entitlement) |
| **Compliance audit log** (`auditLog`) | Durable, hash-chained audit ledger of authz/compliance operations (#134 #177 / ADR-070, EE). | Enabled | audit outbox enqueue (skipped when false) | gated; EE-only (no audit ledger written for CE/free) |
| **API rate limit** (`apiRateLimit`) | Authenticated API-key request rate per window — perKey (per-key fairness) and perTenant (all-keys ceiling), evaluated AND (the stricter trips first → 429) (#175 / ADR-063). | perKey unlimited, perTenant unlimited | per-request API-key limiter (Valkey) | resolved per request; a lower limit takes effect immediately (429 + Retry-After) |
