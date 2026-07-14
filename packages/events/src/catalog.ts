// "Code is truth" domain-event catalog (#139 / ADR-080 doc↔code linkage).
//
// The machine-readable description of every domain event, used to AUTO-GENERATE the events
// reference (the EE webhook / audit surface) from code. Coverage is enforced at the TYPE
// level: `Record<DomainEvent['type'], string>` — adding an event to the DomainEvent union
// is a COMPILE ERROR until it is documented here. A CI stale-guard (pnpm docs:check)
// regenerates the Markdown and fails if it drifts.
//
// CE-only: events are the CE-published bus; the catalog describes what each event MEANS,
// never any payload secret (the events themselves carry only ids/actors, never content).

import type { DomainEvent } from './index.js'

// One entry per DomainEvent `type`. Order here is the order in the generated doc.
export const EVENT_CATALOG: Record<DomainEvent['type'], string> = {
  // Pages
  'page.created': 'A page was created.',
  'page.updated': 'A page body was updated (published).',
  'page.deleted': 'A page was permanently deleted (purged from the trash, or swept by retention).',
  'page.trashed': 'A page (and its subtree) was moved to the trash.',
  'page.trash_restored': 'A page (and its subtree) was restored from the trash.',
  'page.restored': 'A page was restored from a prior revision.',
  'page.published': 'A page revision was published.',
  'page.access_granted': 'A principal was granted a relation on a page.',
  'page.access_revoked': 'A principal lost a relation on a page.',
  'page.access_restricted': 'A principal was restricted (monotonic deny) from a page.',
  'page.access_unrestricted': 'A principal was un-restricted from a page.',
  'page.made_private': 'A page was made private (allowlist — space inheritance cut, public stripped).',
  'page.made_non_private': 'A page was made non-private (space inheritance resumed).',
  'page.made_public': 'A published page was made anonymously public (view_base@user:* granted; noindex on).',
  'page.made_non_public': 'A page was made non-public (the anonymous view_base@user:* grant revoked).',
  'page.frozen': 'A page was frozen (staged edit lock: full = everyone below manage, guests = share-link guests only).',
  'page.unfrozen': 'A page was unfrozen (both freeze markers cleared; every edit path restored).',
  // Spaces
  'space.created': 'A space was created.',
  'space.updated': 'A space was updated.',
  'space.deleted': 'A space was deleted.',
  'space.access_granted': 'A principal was granted a relation on a space.',
  'space.access_revoked': 'A principal lost a relation on a space.',
  'space.branding_updated': 'A space\'s branding (accent) was changed.',
  'space.made_public': 'A space was made anonymously public (space viewer user:* granted; noindex on).',
  'space.made_non_public': 'A space was made non-public (the anonymous space viewer grant revoked).',
  // Tenant
  'tenant.branding_updated': 'The tenant branding (accent + logo) was changed.',
  'tenant.embed_providers_updated': 'A tenant admin changed the external-embed host allowlist (#108).',
  'tenant.oidc_updated': 'The tenant OIDC login configuration was changed.',
  'tenant.oidc_recovered': 'An operator disabled a locked-out tenant\'s OIDC out of band (break-glass).',
  'tenant.saml_recovered': 'An operator disabled a locked-out tenant\'s SAML out of band (break-glass).',
  'tenant.custom_domain_added': 'A custom domain was added (pending verification).',
  'tenant.custom_domain_verified': 'A custom domain was verified and activated.',
  'tenant.custom_domain_removed': 'A custom domain was removed (three-point revocation).',
  'tenant.saml_updated': 'The tenant SAML SSO configuration was changed (EE).',
  'tenant.plan_changed': 'The tenant plan changed (billing).',
  'tenant.ai_toggled': 'A tenant admin enabled/disabled AI for the tenant (ADR-077 consent).',
  'usage.threshold_crossed': 'Metered usage crossed an alert threshold (#128 / ADR-082) — warn before the soft-cap wall; EE/Cloud notifies the admin.',
  // Orphan drafts (admin recovery)
  'orphan_draft.enumerated': 'An admin enumerated orphaned strict-private drafts.',
  'orphan_draft.claimed': 'An admin took a temporary audited claim on an orphaned draft.',
  'orphan_draft.reassigned': 'An orphaned draft was reassigned to a live member.',
  'orphan_draft.claim_expired': 'An un-reassigned orphan-draft claim expired (TTL sweep).',
  // SCIM (EE)
  'scim_token.created': 'A SCIM provisioning token was issued (EE).',
  'scim_token.revoked': 'A SCIM provisioning token was revoked (EE).',
  // Attachments
  'attachment.confirmed': 'An uploaded attachment was confirmed (counts toward storage).',
  'attachment.deleted': 'An attachment was deleted.',
  // Share links
  'share_link.revoked': 'An anonymous share link was revoked.',
  // API keys
  'api_key.created': 'An API key was issued.',
  'api_key.revoked': 'An API key was revoked.',
  // Auth
  'auth.success': 'A principal authenticated successfully.',
  'auth.failed': 'An authentication attempt failed.',
  // Members / invites
  'member.added': 'A member was added to the tenant.',
  'member.role_changed': 'A member\'s role was changed.',
  'member.removed': 'A member was removed from the tenant.',
  'invite.created': 'A member invite was created.',
  'invite.revoked': 'A member invite was revoked.',
  // Comments
  'comment.created': 'A comment was created on a page.',
}
