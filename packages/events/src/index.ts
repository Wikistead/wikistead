// CE-published domain event bus.
// CE routes emit events after successful operations; EE subscribes for audit
// logging, compliance export, webhooks, etc.
//
// emit() is fire-and-forget: handlers run asynchronously and must never block
// the API response. A failed handler logs to stderr but does NOT fail the request.

export type DomainEvent =
  // ── Pages ────────────────────────────────────────────────────────────
  | { type: 'page.created';   tenantId: string; pageId: string; spaceId: string; actorId: string }
  | { type: 'page.updated';   tenantId: string; pageId: string; actorId: string }
  | { type: 'page.deleted';   tenantId: string; pageId: string; actorId: string }
  | { type: 'page.restored';  tenantId: string; pageId: string; fromRevisionId: string; actorId: string }
  | { type: 'page.published'; tenantId: string; pageId: string; revisionId: string; actorId: string }
  | { type: 'page.access_granted'; tenantId: string; pageId: string; grantee: string; relation: string; actorId: string }
  | { type: 'page.access_revoked'; tenantId: string; pageId: string; grantee: string; relation: string; actorId: string }
  // ── Spaces ───────────────────────────────────────────────────────────
  | { type: 'space.created';  tenantId: string; spaceId: string; actorId: string }
  | { type: 'space.updated';  tenantId: string; spaceId: string; actorId: string }
  | { type: 'space.deleted';  tenantId: string; spaceId: string; actorId: string }
  | { type: 'space.access_granted'; tenantId: string; spaceId: string; grantee: string; relation: string; actorId: string }
  | { type: 'space.access_revoked'; tenantId: string; spaceId: string; grantee: string; relation: string; actorId: string }
  | { type: 'space.branding_updated'; tenantId: string; spaceId: string; actorId: string }
  | { type: 'tenant.branding_updated'; tenantId: string; actorId: string }
  | { type: 'tenant.oidc_updated'; tenantId: string; actorId: string; enabled: boolean }
  // Break-glass recovery (#105 / ADR-060): an OPERATOR (not a tenant principal —
  // hence `operator`, not `actorId`) disabled a locked-out tenant's own OIDC out of
  // band, via the admin-DB CLI. It only flips the login gate; it grants no access.
  | { type: 'tenant.oidc_recovered'; tenantId: string; operator: string }
  // Orphan-draft admin handoff (#99 / ADR-061): a tenant#admin enumerated the orphaned
  // strict-private drafts (creator gone + no live viewer). Audited per ADR-061 — the
  // privileged recovery surface is traceable even though enumeration is read-only.
  | { type: 'orphan_draft.enumerated'; tenantId: string; actorId: string; count: number }
  // The two-stage recovery (#99 / ADR-061): claim grants the admin a TEMPORARY audited grant;
  // reassign hands the page to a live member and revokes the admin grant; claim_expired is the
  // TTL sweep revoking an un-reassigned claim (page returns to orphan). All audited for the
  // accountability of the admin's temporary access.
  | { type: 'orphan_draft.claimed'; tenantId: string; actorId: string; pageId: string; expiresAt: string }
  | { type: 'orphan_draft.reassigned'; tenantId: string; actorId: string; pageId: string; newOwner: string }
  | { type: 'orphan_draft.claim_expired'; tenantId: string; pageId: string; adminSub: string }
  // ── Attachments ──────────────────────────────────────────────────────
  | { type: 'attachment.confirmed'; tenantId: string; attachmentId: string; pageId: string; actorId: string }
  | { type: 'attachment.deleted';   tenantId: string; attachmentId: string; pageId: string; actorId: string }
  // ── Share links ──────────────────────────────────────────────────────
  // TODO(phase: guest): emit share_link.revoked in the share link revocation API.
  | { type: 'share_link.revoked'; tenantId: string; shareLinkId: string; pageId: string; actorId: string }
  // ── API keys ─────────────────────────────────────────────────────────
  | { type: 'api_key.created'; tenantId: string; keyId: string; actorId: string }
  | { type: 'api_key.revoked'; tenantId: string; keyId: string; actorId: string }
  // ── Tenant / billing ─────────────────────────────────────────────────
  | { type: 'tenant.plan_changed'; tenantId: string; oldPlan: string | null; newPlan: string }
  // ── Auth ─────────────────────────────────────────────────────────────
  | { type: 'auth.success'; tenantId: string; actorId: string; method: 'oidc' | 'apikey' | 'guest' | 'dev' | string }
  | { type: 'auth.failed';  tenantId: string; method: string; reason: string }
  // ── Members / invites (P1.4) ──────────────────────────────────────────
  | { type: 'member.added';        tenantId: string; targetSub: string; role: string; via: 'invite' | 'provision' | 'bootstrap' }
  | { type: 'member.role_changed'; tenantId: string; actorId: string; targetSub: string; role: string }
  | { type: 'member.removed';      tenantId: string; actorId: string; targetSub: string }
  | { type: 'invite.created';      tenantId: string; actorId: string; role: string }
  | { type: 'invite.revoked';      tenantId: string; actorId: string }
  // ── Comments (P4) ─────────────────────────────────────────────────────
  | { type: 'comment.created'; tenantId: string; actorId: string; pageId: string; threadId: string }

type Handler = (event: DomainEvent) => void | Promise<void>

const _handlers: Handler[] = []

// Register a handler. Returns an unsubscribe function.
export function onDomainEvent(handler: Handler): () => void {
  _handlers.push(handler)
  return () => { const i = _handlers.indexOf(handler); if (i !== -1) _handlers.splice(i, 1) }
}

// Fire-and-forget: all handlers run concurrently.
// A failed handler is logged to stderr so missing audit events are visible
// in application logs, but the error is NOT re-thrown — API responses must
// never depend on event handler success.
//
// TODO(phase: ee-audit): replace console.error with a structured logger
// or a dead-letter queue so EE can distinguish "event fired but handler
// failed" from "event never fired" in compliance forensics.
export function emit(event: DomainEvent): void {
  for (const h of _handlers) {
    void Promise.resolve(h(event)).catch((err) => {
      console.error('[events:handler-error]', event.type, err)
    })
  }
}
