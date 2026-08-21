<!--
  AUTO-GENERATED — DO NOT EDIT BY HAND.
  Source: packages/events/src/catalog.ts (EVENT_CATALOG).
  Regenerate: pnpm docs:gen   ·   Verify (CI): pnpm docs:check
  This is the "code is truth" domain-event reference (the EE webhook / audit surface).
-->

# Webhook events

Every successful operation emits one of the events below. Webhooks, the audit
log and compliance export are all built on them. An event carries ids, who did
it and when — never page content, and never a secret.

| Event | Description |
|---|---|
| `page.created` | A page was created. |
| `page.updated` | A page was renamed or moved. A change to its body arrives as page.published. |
| `page.deleted` | A page was permanently deleted (purged from the trash, or swept by retention). |
| `page.trashed` | A page (and its subtree) was moved to the trash. |
| `page.trash_restored` | A page (and its subtree) was restored from the trash. |
| `page.restored` | A page was restored from a prior revision. |
| `page.published` | A page revision was published. |
| `page.access_granted` | Someone was given access to a page. |
| `page.access_revoked` | Someone's access to a page was taken away. |
| `page.access_restricted` | Someone was blocked from a page. The block beats every other way in, including access given on the page itself; only a manager or moderator can still edit through it. |
| `page.access_unrestricted` | A block on someone's access to a page was lifted. |
| `page.made_private` | A page was made private: only the people named on it can open it, it stops inheriting access from its space, and any public link stops working. |
| `page.made_non_private` | A page stopped being private and inherits access from its space again. |
| `page.made_public` | A published page was opened to anyone with the link, no sign-in needed. Search engines are asked not to index it. |
| `page.made_non_public` | A page stopped being open to anyone; the link no longer works without signing in. |
| `page.frozen` | A page was frozen against edits. Level full stops everyone who can neither manage nor moderate it; level guests stops share-link guests only. |
| `page.unfrozen` | A page was unfrozen and can be edited again. |
| `space.created` | A space was created. |
| `space.updated` | A space was updated. |
| `vendor.access` | An operator used emergency access on this workspace (recorded for Access Transparency). |
| `space.deleted` | A space was deleted. |
| `space.access_granted` | Someone was given access to a space. |
| `space.access_revoked` | Someone's access to a space was taken away. |
| `space.branding_updated` | A space's accent colour was changed. |
| `space.made_public` | A space was opened to anyone with the link, no sign-in needed. Search engines are asked not to index it. |
| `space.made_non_public` | A space stopped being open to anyone; the link no longer works without signing in. |
| `tenant.branding_updated` | The workspace's accent colour and logo were changed. |
| `tenant.embed_providers_updated` | An admin changed which outside sites may be embedded in pages. |
| `tenant.oidc_updated` | The workspace's own OIDC sign-in settings were changed. |
| `tenant.login_methods_updated` | An admin changed which sign-in methods the workspace offers. |
| `tenant.oidc_recovered` | An operator turned OIDC off for a workspace that had locked itself out. |
| `tenant.login_methods_recovered` | An operator set a locked-out workspace's sign-in methods from outside the product, turning one back on if that is what it took. |
| `tenant.saml_recovered` | An operator turned SAML off for a workspace that had locked itself out. |
| `tenant.custom_domain_added` | A custom domain was added (pending verification). |
| `tenant.custom_domain_verified` | A custom domain was verified and activated. |
| `tenant.custom_domain_removed` | A custom domain was removed and stopped serving the workspace. |
| `tenant.custom_domain_unverified` | A verified custom domain stopped proving ownership and went back to pending; links use the workspace's original address until it is verified again. |
| `tenant.saml_updated` | The workspace's SAML single sign-on settings were changed (EE). |
| `tenant.plan_changed` | The workspace's plan changed. |
| `tenant.ai_toggled` | An admin turned AI features on or off for the workspace. |
| `usage.threshold_crossed` | Usage crossed an alert threshold, ahead of the limit that would start turning requests away. EE and Cloud notify the admin. |
| `orphan_draft.enumerated` | An admin listed the private drafts whose author is gone. |
| `orphan_draft.claimed` | An admin took temporary access to an orphaned draft; the claim is recorded. |
| `orphan_draft.reassigned` | An orphaned draft was handed to an active member. |
| `orphan_draft.claim_expired` | A claim on an orphaned draft expired before the draft was handed to anyone. |
| `scim_token.created` | A SCIM provisioning token was issued (EE). |
| `scim_token.revoked` | A SCIM provisioning token was revoked (EE). |
| `attachment.confirmed` | An uploaded attachment was confirmed (counts toward storage). |
| `attachment.deleted` | An attachment was deleted. |
| `share_link.revoked` | An anonymous share link was revoked. |
| `api_key.created` | An API key was issued. |
| `api_key.revoked` | An API key was revoked. The webhook payload includes the key owner: ownerId (member sub) and ownerName (display name, never an email; null if unknown). |
| `auth.success` | Someone signed in successfully. |
| `auth.failed` | A sign-in attempt failed. |
| `member.added` | A member was added to the workspace. |
| `member.role_changed` | A member's role was changed. |
| `member.removed` | A member was removed from the workspace. |
| `member.locked` | Password sign-in was locked for an identifier after repeated failures (it expires on its own). |
| `member.password_changed` | A member changed their own password (their other sessions were signed out). |
| `member.suspended` | An admin suspended a member: sign-in blocked, access taken away, API keys revoked, sessions ended. The membership and its seat stay. |
| `member.reactivated` | An admin brought a suspended member back. Roles that came from a group are not restored — the identity directory adds those again. |
| `member.password_enabled` | An admin gave an existing member a password to sign in with (the account had none before). |
| `member.factor_enrolled` | A member added a second factor to their own account. Which kind it was — an authenticator app or a passkey — is not carried here. |
| `member.factor_removed` | A member removed a second factor from their own account, proving possession of it first. |
| `member.factors_reset` | A member's second factors were cleared so they could enrol again after losing the device; their sessions were ended with it. `reason` says who did it: an admin, or the member themselves with a recovery code. |
| `member.recovery_codes_minted` | A member generated a set of recovery codes for their own account. How many is recorded; the codes themselves are shown once and are never sent anywhere else. |
| `member.recovery_codes_revoked` | A set of recovery codes stopped being usable — replaced by a fresh set (`re-mint`), spent to recover the account (`used`), or cleared with the factors by an admin (`admin_reset`). |
| `tenant.second_factor_policy_changed` | A workspace changed which second factors it requires: off, any, passkeys only, or authenticator apps only. |
| `member.password_removed` | An admin removed a member's password sign-in; their sessions were ended with it. |
| `member.password_reset_requested` | A password reset link was requested for a member. |
| `member.password_reset_completed` | A member completed a password reset (all their sessions were signed out). |
| `invite.created` | A member invite was created. |
| `invite.revoked` | A member invite was revoked. |
| `invite.reissued` | A pending invite was given a fresh link; the previous one stopped working. |
| `comment.created` | A comment was created on a page. |
