// #862 / ADR-108 addendum: what leaves the tenant, decided one event type at a time.
//
// The bridge was wired to carry everything the catalogue holds, and nobody had read the payloads.
// Fifty of the seventy-six types reached a tenant-controlled URL without passing any per-instance
// authorization check — the twenty-five that carried a `pageId` were gated by `pageEventDisposition`
// at delivery, and the rest were gated by nothing. Four of those payloads turned out to reverse or
// stretch a decision this repository had already made, and the owner ruled on them on 2026-08-22.
// A fifth ruling followed on 2026-08-27 (§K), which is why twenty-TWO carry a `pageId` today. A sixth
// followed on 2026-09-03 (§M, #1019): the 2026-08-22 ruling on the two password-reset events was
// retracted as self-contradictory, so they ship `targetSub` again.
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
// that no union member declares: `actorKeyId` and `occurredAt`. Both are stamped by
// `enqueueWebhookOutbox`, at the write, because two of the three roads to a durable row do not come
// through the bus. A table of declared fields would have made the allow-list strip the key from sixty
// events and reverse ADR-221 §9 in silence.
import type { DomainEvent } from '@wikistead/events'

/**
 * What a type is allowed to send outside the tenant.
 *
 * `send`   — the fields named, and nothing else.
 * `drop`   — nothing leaves. The event still happens; no row is written.
 * `redact` — the fields named leave; `withheld` records what a ruling held back, so the reason stays
 *            visible at the row instead of only in the ADR.
 *
 * ⚠️ `fields` is an ALLOW-LIST, not a description. ADR-108 addendum §H: the payload used to be the
 * whole event spread into a row, so a field added to any type tomorrow left the tenant the day it was
 * added, and a row-per-TYPE table would not have noticed. Naming what may leave is the only shape in
 * which adding a field is inert until somebody adds it here too.
 */
export type EgressVerdict =
  | { kind: 'send'; fields: readonly string[] }
  | { kind: 'drop'; why: string }
  | { kind: 'redact'; fields: readonly string[]; withheld: readonly string[]; why: string }

const send = (...fields: string[]) => ({ kind: 'send', fields }) as const
const drop = (why: string) => ({ kind: 'drop', why }) as const
// `withheld` comes first because it is the ruling; the rest is the payload it was taken out of, and
// the filter is what keeps the two from disagreeing when somebody edits one of them.
const redact = (withheld: readonly string[], why: string, ...fields: string[]) =>
  ({ kind: 'redact', fields: fields.filter((f) => !withheld.includes(f)), withheld, why }) as const

/**
 * ⚠️ Every type in the catalogue, with what it may carry. Keyed on the union so the compiler asks
 * about the next one.
 *
 * The entries that are not `send` are the rulings below; the ADR carries the argument behind each.
 * Everything else ships because it names things the receiving tenant administers and can already read
 * in its own console — which is what an integration exists for.
 */
export const EGRESS: Record<DomainEvent['type'], EgressVerdict> = {
  // ⚠️ The entries that are not `send` are the rulings below; the ADR carries the argument behind
  // each, and the reason is on the entry so a reader of this file does not have to go and find it.
  //
  //   §C  the three break-glass events name a member of Wikistead staff. `vendor.access`, in the same
  //       catalogue, is annotated "never the operator id" and ADR-169 says the same. Worse: Access
  //       Transparency is a top-tier lever while webhooks start at Personal, so the unredacted name
  //       would reach a plan that cannot see the redacted feed.
  //   §D  `member.locked`'s identifier is whatever an unauthenticated caller typed at the login form.
  //       Delivering it relays attacker-supplied input to a tenant-controlled URL, and the type's own
  //       annotation names a webhook consumer as the threat — written when no consumer existed.
  //   §E  RETRACTED (§M, 2026-09-03) — do not read this section as current. It stripped the subject
  //       from the two password-reset events; that ruling contradicted the reasoning it gave for
  //       reaching it. See §M below.
  //   §F  both auth events come from the per-request principal resolver, and the bridge does not ask
  //       whether the tenant has a hook at all — so an unauthenticated caller can make this product
  //       write a row per request. Anonymous share-link editing is the product's centre, so every
  //       keystroke flush is one of these.
  //   §K  the orphan-draft trio carried a `pageId`, and an orphan draft is unpublished by definition —
  //       so it never holds a `page#space` tuple, the delivery gate answered `not-ready` every time,
  //       and all three were dropped after six retries. They were in the catalogue and unreachable.
  //       Withholding the page id takes them out of the gate's reach, so the operational fact ("a
  //       claim expired") arrives while WHICH draft it was on stays inside the tenant.
  //   §M  (#1019, 2026-09-03) the two password-reset events ship `targetSub` again — §E's strip is
  //       retracted, not revised: it named `member.factors_reset` as an equally timing-sharp fact and
  //       shipped it anyway, so its own reasoning never supported stripping only these two. A sibling
  //       proposal to add a CONDITIONAL `targetSub` to `member.locked` (only when the typed identifier
  //       happened to resolve) was considered and REFUSED — §D stands unchanged, in full, below.
  'page.created': send('pageId', 'spaceId', 'actorId', 'actorKeyId', 'occurredAt'),
  'page.renamed': send('pageId', 'actorId', 'actorKeyId', 'occurredAt'),
  'page.moved': send('pageId', 'actorId', 'actorKeyId', 'occurredAt'),
  'page.deleted': send('pageId', 'actorId', 'actorKeyId', 'occurredAt'),
  'page.trashed': send('pageId', 'actorId', 'actorKeyId', 'occurredAt'),
  'page.trash_restored': send('pageId', 'actorId', 'actorKeyId', 'occurredAt'),
  'page.restored': send('pageId', 'fromRevisionId', 'actorId', 'actorKeyId', 'occurredAt'),
  'page.published': send('pageId', 'revisionId', 'actorId', 'actorKeyId', 'occurredAt'),
  'page.access_granted': send('pageId', 'grantee', 'relation', 'actorId', 'actorKeyId', 'occurredAt'),
  'page.access_revoked': send('pageId', 'grantee', 'relation', 'actorId', 'actorKeyId', 'occurredAt'),
  'page.access_restricted': send('pageId', 'grantee', 'relation', 'actorId', 'actorKeyId', 'occurredAt'),
  'page.access_unrestricted': send('pageId', 'grantee', 'relation', 'actorId', 'actorKeyId', 'occurredAt'),
  'page.made_private': send('pageId', 'actorId', 'actorKeyId', 'occurredAt'),
  'page.made_non_private': send('pageId', 'actorId', 'actorKeyId', 'occurredAt'),
  'page.made_public': send('pageId', 'actorId', 'actorKeyId', 'occurredAt'),
  'page.made_non_public': send('pageId', 'actorId', 'actorKeyId', 'occurredAt'),
  'page.frozen': send('pageId', 'level', 'actorId', 'actorKeyId', 'occurredAt'),
  'page.unfrozen': send('pageId', 'actorId', 'actorKeyId', 'occurredAt'),
  'space.created': send('spaceId', 'actorId', 'actorKeyId', 'occurredAt'),
  'space.updated': send('spaceId', 'actorId', 'actorKeyId', 'occurredAt'),
  'vendor.access': send('action', 'at', 'occurredAt'), // already redacted at the source (ADR-169): action code and timestamp only
  'space.deleted': send('spaceId', 'actorId', 'actorKeyId', 'occurredAt'),
  'space.access_granted': send('spaceId', 'grantee', 'relation', 'actorId', 'actorKeyId', 'occurredAt'),
  'space.access_revoked': send('spaceId', 'grantee', 'relation', 'actorId', 'actorKeyId', 'occurredAt'),
  'space.branding_updated': send('spaceId', 'actorId', 'actorKeyId', 'occurredAt'),
  'space.made_public': send('spaceId', 'actorId', 'actorKeyId', 'occurredAt'),
  'space.made_non_public': send('spaceId', 'actorId', 'actorKeyId', 'occurredAt'),
  'tenant.branding_updated': send('actorId', 'actorKeyId', 'occurredAt'),
  'tenant.embed_providers_updated': send('actorId', 'count', 'actorKeyId', 'occurredAt'),
  'tenant.oidc_updated': send('actorId', 'enabled', 'actorKeyId', 'occurredAt'),
  'tenant.login_methods_updated': send('actorId', 'platformLoginEnabled', 'actorKeyId', 'occurredAt'),
  'tenant.oidc_recovered': drop('#862 / ADR-108 §C (2026-08-22): never the operator id — ADR-169'),
  'tenant.login_methods_recovered': drop('#862 / ADR-108 §C (2026-08-22): never the operator id — ADR-169'),
  'tenant.saml_recovered': drop('#862 / ADR-108 §C (2026-08-22): never the operator id — ADR-169'),
  'orphan_draft.enumerated': send('actorId', 'count', 'actorKeyId', 'occurredAt'),
  'orphan_draft.claimed': redact(['pageId'], '#862 / ADR-108 §K (2026-08-27): the claim is reportable, which draft it is on is not', 'actorId', 'pageId', 'expiresAt', 'actorKeyId', 'occurredAt'),
  'orphan_draft.reassigned': redact(['pageId'], '#862 / ADR-108 §K (2026-08-27): the claim is reportable, which draft it is on is not', 'actorId', 'pageId', 'newOwner', 'actorKeyId', 'occurredAt'),
  'orphan_draft.claim_expired': redact(['pageId'], '#862 / ADR-108 §K (2026-08-27): the claim is reportable, which draft it is on is not', 'pageId', 'adminSub', 'occurredAt'),
  'tenant.custom_domain_added': send('domain', 'occurredAt'),
  'tenant.custom_domain_verified': send('domain', 'occurredAt'),
  'tenant.custom_domain_removed': send('domain', 'occurredAt'),
  'tenant.custom_domain_unverified': send('domain', 'occurredAt'),
  'tenant.saml_updated': send('actorId', 'enabled', 'actorKeyId', 'occurredAt'),
  'tenant.ai_toggled': send('actorId', 'enabled', 'actorKeyId', 'occurredAt'),
  'usage.threshold_crossed': send('resource', 'threshold', 'period', 'occurredAt'),
  'scim_token.created': send('actorId', 'tokenId', 'actorKeyId', 'occurredAt'),
  'scim_token.revoked': send('actorId', 'tokenId', 'actorKeyId', 'occurredAt'),
  'attachment.confirmed': send('attachmentId', 'pageId', 'actorId', 'actorKeyId', 'occurredAt'),
  'attachment.deleted': send('attachmentId', 'pageId', 'actorId', 'actorKeyId', 'occurredAt'),
  'share_link.revoked': send('shareLinkId', 'pageId', 'actorId', 'actorKeyId', 'occurredAt'),
  'api_key.created': send('keyId', 'actorId', 'actorKeyId', 'occurredAt'),
  'api_key.revoked': send('keyId', 'actorId', 'ownerId', 'actorKeyId', 'occurredAt'), // in-transaction at its call site; the resolved owner name is dropped there
  'tenant.plan_changed': send('oldPlan', 'newPlan', 'occurredAt'),
  'auth.success': drop('#862 / ADR-108 §F (2026-08-22): one row per request, reachable unauthenticated'),
  'auth.failed': drop('#862 / ADR-108 §F (2026-08-22): one row per request, reachable unauthenticated'),
  'member.added': send('targetSub', 'role', 'via', 'occurredAt'),
  'member.role_changed': send('actorId', 'targetSub', 'role', 'actorKeyId', 'occurredAt'),
  'member.removed': send('actorId', 'targetSub', 'actorKeyId', 'occurredAt'),
  'member.locked': redact(['identifier'], '#862 / ADR-108 §D (2026-08-22): the value is supplied by whoever is attacking the door', 'identifier', 'occurredAt'),
  'member.password_changed': send('targetSub', 'occurredAt'),
  'member.password_enabled': send('actorId', 'targetSub', 'actorKeyId', 'occurredAt'),
  'member.suspended': send('actorId', 'targetSub', 'actorKeyId', 'occurredAt'),
  'member.reactivated': send('actorId', 'targetSub', 'actorKeyId', 'occurredAt'),
  'member.password_removed': send('actorId', 'targetSub', 'actorKeyId', 'occurredAt'),
  'member.factor_enrolled': send('actorId', 'targetSub', 'actorKeyId', 'occurredAt'),
  'member.factor_removed': send('actorId', 'targetSub', 'actorKeyId', 'occurredAt'),
  'member.factors_reset': send('actorId', 'targetSub', 'count', 'reason', 'actorKeyId', 'occurredAt'),
  'member.recovery_codes_minted': send('actorId', 'targetSub', 'count', 'actorKeyId', 'occurredAt'),
  'member.recovery_codes_revoked': send('actorId', 'targetSub', 'reason', 'actorKeyId', 'occurredAt'),
  'tenant.second_factor_policy_changed': send('actorId', 'required', 'kinds', 'actorKeyId', 'occurredAt'),
  // #1019 / ADR-108 §M (2026-09-03): §E's strip on these two is RETRACTED, not merely revised — the
  // ruling that stripped them contradicted its own stated reasoning (§E's retraction note explains
  // why). They ship `targetSub` like every other member.* security event now.
  'member.password_reset_requested': send('actorId', 'targetSub', 'actorKeyId', 'occurredAt'),
  'member.password_reset_completed': send('targetSub', 'occurredAt'),
  'invite.created': send('actorId', 'role', 'actorKeyId', 'occurredAt'),
  'invite.revoked': send('actorId', 'actorKeyId', 'occurredAt'),
  'invite.reissued': send('actorId', 'emailed', 'actorKeyId', 'occurredAt'),
  'comment.created': send('actorId', 'pageId', 'threadId', 'actorKeyId', 'occurredAt'),
}

/** What this type may send, if anything. */
export const egressVerdict = (type: DomainEvent['type']): EgressVerdict => EGRESS[type]
