// CE-published domain event bus.
// CE routes emit events after successful operations; EE subscribes for audit
// logging, compliance export, webhooks, etc.
//
// emit() is fire-and-forget: handlers run asynchronously and must never block
// the API response. A failed handler does not fail the request.

export type DomainEvent =
  // ── Pages ────────────────────────────────────────────────────────────
  | { type: 'page.created';   tenantId: string; pageId: string; spaceId: string; actorId: string }
  | { type: 'page.updated';   tenantId: string; pageId: string; actorId: string }
  | { type: 'page.deleted';   tenantId: string; pageId: string; actorId: string }
  | { type: 'page.restored';  tenantId: string; pageId: string; fromRevisionId: string; actorId: string }
  // ── Spaces ───────────────────────────────────────────────────────────
  | { type: 'space.created';  tenantId: string; spaceId: string; actorId: string }
  | { type: 'space.deleted';  tenantId: string; spaceId: string; actorId: string }
  // ── Attachments ──────────────────────────────────────────────────────
  | { type: 'attachment.confirmed'; tenantId: string; attachmentId: string; pageId: string; actorId: string }
  | { type: 'attachment.deleted';   tenantId: string; attachmentId: string; pageId: string; actorId: string }
  // ── Share links ──────────────────────────────────────────────────────
  | { type: 'share_link.revoked'; tenantId: string; shareLinkId: string; pageId: string; actorId: string }
  // ── API keys ─────────────────────────────────────────────────────────
  | { type: 'api_key.created'; tenantId: string; keyId: string; actorId: string }
  | { type: 'api_key.revoked'; tenantId: string; keyId: string; actorId: string }
  // ── Tenant / billing ─────────────────────────────────────────────────
  | { type: 'tenant.plan_changed'; tenantId: string; oldPlan: string | null; newPlan: string }
  // ── Auth ─────────────────────────────────────────────────────────────
  | { type: 'auth.success'; tenantId: string; actorId: string; method: 'oidc' | 'apikey' | 'guest' | 'dev' | string }
  | { type: 'auth.failed';  tenantId: string; method: string; reason: string }

type Handler = (event: DomainEvent) => void | Promise<void>

const _handlers: Handler[] = []

// Register a handler. Returns an unsubscribe function.
export function onDomainEvent(handler: Handler): () => void {
  _handlers.push(handler)
  return () => { const i = _handlers.indexOf(handler); if (i !== -1) _handlers.splice(i, 1) }
}

// Fire-and-forget: all handlers run concurrently; errors are swallowed.
// API responses must never depend on event handler success.
export function emit(event: DomainEvent): void {
  for (const h of _handlers) void Promise.resolve(h(event)).catch(() => {})
}
