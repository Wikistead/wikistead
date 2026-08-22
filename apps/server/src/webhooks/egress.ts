// #862 / ADR-108 addendum: what leaves the tenant, decided one event type at a time.
//
// The bridge was wired to carry everything the catalogue holds, and nobody had read the payloads.
// Fifty of the seventy-six types reach a tenant-controlled URL without passing any per-instance
// authorization check — the twenty-five that carry a `pageId` are gated by `pageEventDisposition` at
// delivery, and the rest are not gated by anything. Four of those payloads turned out to reverse or
// stretch a decision this repository had already made, and the owner ruled on them on 2026-08-22.
//
// ── Why a table, and why it is keyed on the union ───────────────────────────────────────────────
//
// `Record<DomainEvent['type'], …>` is the mechanism, not decoration: a type added to the catalogue
// tomorrow does not compile until somebody decides what it may carry. That is a compile error rather
// than a test failure, which matters because the test suite stayed green when a fictional type was
// added to the catalogue — measured, and it is how the operator-name events were missed the first
// time.
//
// ⚠️ The verdicts talk about the DELIVERED payload, not the declared type. Two fields reach the wire
// that no union member declares: `actorKeyId`, distributed onto every event with an `actorId` by
// ADR-221 §9's conditional type, and `occurredAt`, stamped by `webhookPayload`. A table of declared
// fields would have made `redact` strip the key from sixty events and reverse ADR-221 §9 in silence.
import type { DomainEvent } from '@wikistead/events'

/**
 * What a type is allowed to send outside the tenant.
 *
 * `send`   — the payload as it is.
 * `drop`   — never bridged. The event still happens; nothing leaves.
 * `redact` — bridged with the named fields removed.
 */
export type EgressVerdict = { kind: 'send' } | { kind: 'drop'; why: string } | { kind: 'redact'; fields: readonly string[]; why: string }

const send = { kind: 'send' } as const
const drop = (why: string) => ({ kind: 'drop', why }) as const
const redact = (fields: readonly string[], why: string) => ({ kind: 'redact', fields, why }) as const

/**
 * ⚠️ Every type in the catalogue, with what it may carry. Keyed on the union so the compiler asks
 * about the next one.
 *
 * The four rulings of 2026-08-22 are the entries that are not `send`; the ADR carries the argument
 * behind each. Everything else ships because it names things the receiving tenant administers and can
 * already read in its own console — which is what an integration exists for.
 */
export const EGRESS: Record<DomainEvent['type'], EgressVerdict> = {
  // ⚠️ The entries that are not `send` are the four rulings of 2026-08-22; the ADR carries the argument
  // behind each, and the reason is on the entry so a reader of this file does not have to go and find it.
  //
  //   §C  the three break-glass events name a member of Wikistead staff. `vendor.access`, in the same
  //       catalogue, is annotated "never the operator id" and ADR-169 says the same. Worse: Access
  //       Transparency is a top-tier lever while webhooks start at Personal, so the unredacted name
  //       would reach a plan that cannot see the redacted feed.
  //   §D  `member.locked`'s identifier is whatever an unauthenticated caller typed at the login form.
  //       Delivering it relays attacker-supplied input to a tenant-controlled URL, and the type's own
  //       annotation names a webhook consumer as the threat — written when no consumer existed.
  //   §E  the two password-reset events lose their subject. "A reset window is open" is the useful
  //       fact; WHOSE window is the part that is sharp in time. The other security events ship: the
  //       audit ledger is top-tier only while webhooks start at Personal, so this can be the tenant's
  //       only copy.
  //   §F  both auth events come from the per-request principal resolver, and the bridge does not ask
  //       whether the tenant has a hook at all — so an unauthenticated caller can make this product
  //       write a row per request. Anonymous share-link editing is the product's centre, so every
  //       keystroke flush is one of these.
  'page.created': send,
  'page.renamed': send,
  'page.moved': send,
  'page.deleted': send,
  'page.trashed': send,
  'page.trash_restored': send,
  'page.restored': send,
  'page.published': send,
  'page.access_granted': send,
  'page.access_revoked': send,
  'page.access_restricted': send,
  'page.access_unrestricted': send,
  'page.made_private': send,
  'page.made_non_private': send,
  'page.made_public': send,
  'page.made_non_public': send,
  'page.frozen': send,
  'page.unfrozen': send,
  'space.created': send,
  'space.updated': send,
  'vendor.access': send, // already redacted at the source (ADR-169): action code and timestamp only
  'space.deleted': send,
  'space.access_granted': send,
  'space.access_revoked': send,
  'space.branding_updated': send,
  'space.made_public': send,
  'space.made_non_public': send,
  'tenant.branding_updated': send,
  'tenant.embed_providers_updated': send,
  'tenant.oidc_updated': send,
  'tenant.login_methods_updated': send,
  'tenant.oidc_recovered': drop('#862 / ADR-108 §C (2026-08-22): never the operator id — ADR-169'),
  'tenant.login_methods_recovered': drop('#862 / ADR-108 §C (2026-08-22): never the operator id — ADR-169'),
  'tenant.saml_recovered': drop('#862 / ADR-108 §C (2026-08-22): never the operator id — ADR-169'),
  'orphan_draft.enumerated': send,
  'orphan_draft.claimed': send,
  'orphan_draft.reassigned': send,
  'orphan_draft.claim_expired': send,
  'tenant.custom_domain_added': send,
  'tenant.custom_domain_verified': send,
  'tenant.custom_domain_removed': send,
  'tenant.custom_domain_unverified': send,
  'tenant.saml_updated': send,
  'tenant.ai_toggled': send,
  'usage.threshold_crossed': send,
  'scim_token.created': send,
  'scim_token.revoked': send,
  'attachment.confirmed': send,
  'attachment.deleted': send,
  'share_link.revoked': send,
  'api_key.created': send,
  'api_key.revoked': send, // in-transaction at its call site; the resolved owner name is dropped there
  'tenant.plan_changed': send,
  'auth.success': drop('#862 / ADR-108 §F (2026-08-22): one row per request, reachable unauthenticated'),
  'auth.failed': drop('#862 / ADR-108 §F (2026-08-22): one row per request, reachable unauthenticated'),
  'member.added': send,
  'member.role_changed': send,
  'member.removed': send,
  'member.locked': redact(['identifier'], '#862 / ADR-108 §D (2026-08-22): the value is supplied by whoever is attacking the door'),
  'member.password_changed': send,
  'member.password_enabled': send,
  'member.suspended': send,
  'member.reactivated': send,
  'member.password_removed': send,
  'member.factor_enrolled': send,
  'member.factor_removed': send,
  'member.factors_reset': send,
  'member.recovery_codes_minted': send,
  'member.recovery_codes_revoked': send,
  'tenant.second_factor_policy_changed': send,
  'member.password_reset_requested': redact(['targetSub'], '#862 / ADR-108 §E (2026-08-22): the window is reportable, the subject is not'),
  'member.password_reset_completed': redact(['targetSub'], '#862 / ADR-108 §E (2026-08-22): the window is reportable, the subject is not'),
  'invite.created': send,
  'invite.revoked': send,
  'invite.reissued': send,
  'comment.created': send,
}

/** What this type may send, if anything. */
export const egressVerdict = (type: DomainEvent['type']): EgressVerdict => EGRESS[type]
