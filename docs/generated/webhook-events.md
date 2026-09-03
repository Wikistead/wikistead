<!--
  AUTO-GENERATED — DO NOT EDIT BY HAND.
  Source: packages/events/src/catalog.ts (EVENT_CATALOG) + apps/server/src/webhooks/egress.ts.
  Regenerate: pnpm docs:gen   ·   Verify (CI): pnpm docs:check
  This is the "code is truth" domain-event reference (the EE webhook / audit surface).
-->

# Webhook events

Every successful operation emits one of the events below. Webhooks, the audit
log and compliance export are all built on them. An event carries ids, who did
it and when — never page content, and never a secret.

A few events stay inside your workspace and are never sent to a webhook. Sign-in
attempts are one per request, so delivering them would be a firehose rather than a
signal; recovery actions by our staff are reported to you without naming the person
who performed them. The last column says what each event sends.

The last column is about the KIND of event. Separately, an event about one page is
checked against that page when it is about to be sent: nothing is sent about a private
page or about a draft that has never been published, because the id alone would say
the page exists. So an event marked as sent can still be withheld for one page.

| Event | Description | Sent to webhooks |
|---|---|---|
| `page.created` | A page was created. | Yes |
| `page.renamed` | A page was given a new title. | Yes |
| `page.moved` | A page was moved to a different parent or space. | Yes |
| `page.deleted` | A page was permanently deleted (purged from the trash, or swept by retention). | Yes |
| `page.trashed` | A page (and its subtree) was moved to the trash. | Yes |
| `page.trash_restored` | A page (and its subtree) was restored from the trash. | Yes |
| `page.restored` | A page was restored from a prior revision. | Yes |
| `page.published` | A page revision was published. | Yes |
| `page.access_granted` | Someone was given access to a page. | Yes |
| `page.access_revoked` | Someone's access to a page was taken away. | Yes |
| `page.access_restricted` | Someone was blocked from a page. The block beats every other way in, including access given on the page itself; only a manager or moderator can still edit through it. | Yes |
| `page.access_unrestricted` | A block on someone's access to a page was lifted. | Yes |
| `page.made_private` | A page was made private: only the people named on it can open it, it stops inheriting access from its space, and any public link stops working. | Yes |
| `page.made_non_private` | A page stopped being private and inherits access from its space again. | Yes |
| `page.made_public` | A published page was opened to anyone with the link, no sign-in needed. Search engines are asked not to index it. | Yes |
| `page.made_non_public` | A page stopped being open to anyone; the link no longer works without signing in. | Yes |
| `page.frozen` | A page was frozen against edits. Level full stops everyone who can neither manage nor moderate it; level guests stops share-link guests only. | Yes |
| `page.unfrozen` | A page was unfrozen and can be edited again. | Yes |
| `space.created` | A space was created. | Yes |
| `space.updated` | A space was updated. | Yes |
| `vendor.access` | An operator used emergency access on this workspace (recorded for Access Transparency). | Yes |
| `space.deleted` | A space was deleted. | Yes |
| `space.access_granted` | Someone was given access to a space. | Yes |
| `space.access_revoked` | Someone's access to a space was taken away. | Yes |
| `space.branding_updated` | A space's accent colour was changed. | Yes |
| `space.made_public` | A space was opened to anyone with the link, no sign-in needed. Search engines are asked not to index it. | Yes |
| `space.made_non_public` | A space stopped being open to anyone; the link no longer works without signing in. | Yes |
| `tenant.branding_updated` | The workspace's accent colour and logo were changed. | Yes |
| `tenant.embed_providers_updated` | An admin changed which outside sites may be embedded in pages. | Yes |
| `tenant.oidc_updated` | The workspace's own OIDC sign-in settings were changed. | Yes |
| `tenant.login_methods_updated` | An admin changed which sign-in methods the workspace offers. | Yes |
| `tenant.oidc_recovered` | An operator turned OIDC off for a workspace that had locked itself out. | No |
| `tenant.login_methods_recovered` | An operator set a locked-out workspace's sign-in methods from outside the product, turning one back on if that is what it took. | No |
| `tenant.saml_recovered` | An operator turned SAML off for a workspace that had locked itself out. | No |
| `tenant.custom_domain_added` | A custom domain was added (pending verification). | Yes |
| `tenant.custom_domain_verified` | A custom domain was verified and activated. | Yes |
| `tenant.custom_domain_removed` | A custom domain was removed and stopped serving the workspace. | Yes |
| `tenant.custom_domain_unverified` | A verified custom domain stopped proving ownership and went back to pending; links use the workspace's original address until it is verified again. | Yes |
| `tenant.saml_updated` | The workspace's SAML single sign-on settings were changed (EE). | Yes |
| `tenant.plan_changed` | The workspace's plan changed. | Yes |
| `tenant.ai_toggled` | An admin turned AI features on or off for the workspace. | Yes |
| `usage.threshold_crossed` | Usage crossed an alert threshold, ahead of the limit that would start turning requests away. EE and Cloud notify the admin. | Yes |
| `orphan_draft.enumerated` | An admin listed the private drafts whose author is gone. | Yes |
| `orphan_draft.claimed` | An admin took temporary access to an orphaned draft; the claim is recorded. | Yes, without `pageId` |
| `orphan_draft.reassigned` | An orphaned draft was handed to an active member. | Yes, without `pageId` |
| `orphan_draft.claim_expired` | A claim on an orphaned draft expired before the draft was handed to anyone. | Yes, without `pageId` |
| `scim_token.created` | A SCIM provisioning token was issued (EE). | Yes |
| `scim_token.revoked` | A SCIM provisioning token was revoked (EE). | Yes |
| `attachment.confirmed` | An uploaded attachment was confirmed (counts toward storage). | Yes |
| `attachment.deleted` | An attachment was deleted. | Yes |
| `share_link.revoked` | An anonymous share link was revoked. | Yes |
| `api_key.created` | An API key was issued. | Yes |
| `api_key.revoked` | An API key was revoked. The webhook payload includes the key owner id (ownerId, the member sub). The display name is not sent. | Yes |
| `auth.success` | A request satisfied authentication (including API-key, guest, and dev auth). Fires once per request, not once per sign-in. Not delivered to webhooks. | No |
| `auth.failed` | A sign-in attempt failed. | No |
| `member.added` | A member was added to the workspace. | Yes |
| `member.role_changed` | A member's role was changed. | Yes |
| `member.removed` | A member was removed from the workspace. | Yes |
| `member.locked` | Password sign-in was locked for an identifier after repeated failures (it expires on its own). | Yes, without `identifier` |
| `member.password_changed` | A member changed their own password (their other sessions were signed out). | Yes |
| `member.suspended` | An admin suspended a member: sign-in blocked, access taken away, API keys revoked, sessions ended. The membership and its seat stay. | Yes |
| `member.reactivated` | An admin brought a suspended member back. Roles that came from a group are not restored — the identity directory adds those again. | Yes |
| `member.password_enabled` | An admin gave an existing member a password to sign in with (the account had none before). | Yes |
| `member.factor_enrolled` | A member added a second factor to their own account. Which kind it was — an authenticator app or a passkey — is not carried here. | Yes |
| `member.factor_removed` | A member removed a second factor from their own account, proving possession of it first. | Yes |
| `member.factors_reset` | A member's second factors were cleared so they could enrol again after losing the device; their sessions were ended with it. `reason` says who did it: an admin, or the member themselves with a recovery code. | Yes |
| `member.recovery_codes_minted` | A member generated a set of recovery codes for their own account. How many is recorded; the codes themselves are shown once and are never sent anywhere else. | Yes |
| `member.recovery_codes_revoked` | A set of recovery codes stopped being usable — replaced by a fresh set (`re-mint`), spent to recover the account (`used`), or cleared with the factors by an admin (`admin_reset`). | Yes |
| `tenant.second_factor_policy_changed` | A workspace changed which second factors it requires: off, any, passkeys only, or authenticator apps only. | Yes |
| `member.password_removed` | An admin removed a member's password sign-in; their sessions were ended with it. | Yes |
| `member.password_reset_requested` | A password reset link was requested for a member. | Yes |
| `member.password_reset_completed` | A member completed a password reset (all their sessions were signed out). | Yes |
| `member.signed_in` | A member's session was established: local sign-in, local with a second factor, a federated (OIDC/SAML) sign-in, or an operator break-glass invite acceptance (`door`, never the operator's own identity). Delivered. | Yes |
| `invite.created` | A member invite was created. | Yes |
| `invite.revoked` | A member invite was revoked. | Yes |
| `invite.reissued` | A pending invite was given a fresh link; the previous one stopped working. | Yes |
| `comment.created` | A comment was created on a page. | Yes |
