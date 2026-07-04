<!--
  AUTO-GENERATED — DO NOT EDIT BY HAND.
  Source: packages/events/src/catalog.ts (EVENT_CATALOG).
  Regenerate: pnpm docs:gen   ·   Verify (CI): pnpm docs:check
  This is the "code is truth" domain-event reference (the EE webhook / audit surface).
-->

# Domain events

The CE event bus emits a `DomainEvent` after each successful operation. EE features
(webhooks, audit log, compliance export) subscribe to these. Events carry only ids,
actors, and timestamps — never page content or secrets. Generated from the code
(`EVENT_CATALOG`).

| Event | Description |
|---|---|
| `page.created` | A page was created. |
| `page.updated` | A page body was updated (published). |
| `page.deleted` | A page was deleted. |
| `page.restored` | A page was restored from a prior revision. |
| `page.published` | A page revision was published. |
| `page.access_granted` | A principal was granted a relation on a page. |
| `page.access_revoked` | A principal lost a relation on a page. |
| `page.access_restricted` | A principal was restricted (monotonic deny) from a page. |
| `page.access_unrestricted` | A principal was un-restricted from a page. |
| `page.made_private` | A page was made private (allowlist — space inheritance cut, public stripped). |
| `page.made_non_private` | A page was made non-private (space inheritance resumed). |
| `space.created` | A space was created. |
| `space.updated` | A space was updated. |
| `space.deleted` | A space was deleted. |
| `space.access_granted` | A principal was granted a relation on a space. |
| `space.access_revoked` | A principal lost a relation on a space. |
| `space.branding_updated` | A space's branding (accent) was changed. |
| `tenant.branding_updated` | The tenant branding (accent + logo) was changed. |
| `tenant.embed_providers_updated` | A tenant admin changed the external-embed host allowlist (#108). |
| `tenant.oidc_updated` | The tenant OIDC login configuration was changed. |
| `tenant.oidc_recovered` | An operator disabled a locked-out tenant's OIDC out of band (break-glass). |
| `tenant.custom_domain_added` | A custom domain was added (pending verification). |
| `tenant.custom_domain_verified` | A custom domain was verified and activated. |
| `tenant.custom_domain_removed` | A custom domain was removed (three-point revocation). |
| `tenant.saml_updated` | The tenant SAML SSO configuration was changed (EE). |
| `tenant.plan_changed` | The tenant plan changed (billing). |
| `tenant.ai_toggled` | A tenant admin enabled/disabled AI for the tenant (ADR-077 consent). |
| `usage.threshold_crossed` | Metered usage crossed an alert threshold (#128 / ADR-082) — warn before the soft-cap wall; EE/Cloud notifies the admin. |
| `orphan_draft.enumerated` | An admin enumerated orphaned strict-private drafts. |
| `orphan_draft.claimed` | An admin took a temporary audited claim on an orphaned draft. |
| `orphan_draft.reassigned` | An orphaned draft was reassigned to a live member. |
| `orphan_draft.claim_expired` | An un-reassigned orphan-draft claim expired (TTL sweep). |
| `scim_token.created` | A SCIM provisioning token was issued (EE). |
| `scim_token.revoked` | A SCIM provisioning token was revoked (EE). |
| `attachment.confirmed` | An uploaded attachment was confirmed (counts toward storage). |
| `attachment.deleted` | An attachment was deleted. |
| `share_link.revoked` | An anonymous share link was revoked. |
| `api_key.created` | An API key was issued. |
| `api_key.revoked` | An API key was revoked. |
| `auth.success` | A principal authenticated successfully. |
| `auth.failed` | An authentication attempt failed. |
| `member.added` | A member was added to the tenant. |
| `member.role_changed` | A member's role was changed. |
| `member.removed` | A member was removed from the tenant. |
| `invite.created` | A member invite was created. |
| `invite.revoked` | A member invite was revoked. |
| `comment.created` | A comment was created on a page. |
