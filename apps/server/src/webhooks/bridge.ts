// #862 / ADR-108 Q4: every event the catalogue names reaches the webhook outbox.
//
// The catalogue lists 75 event types and the documentation says webhooks are built on it. Two of them
// were actually delivered: `page.published` and `api_key.revoked`, each because somebody remembered to
// call `enqueueWebhookOutbox` by hand at that one call site. The other seventy-three were emitted onto
// the in-process bus and went nowhere — a subscriber wired for `share_link.revoked` (Valkey) and one
// for `usage.threshold_crossed` (a log line) were the only listeners in the tree.
//
// A per-call-site enqueue cannot close that: there are 133 `emit` sites and the next one will forget
// too, exactly as the previous seventy-three did. So the bridge is ONE subscriber, and what it carries
// is derived from the event rather than from a list of types anybody has to maintain.
//
// ── what makes this a reliable path ────────────────────────────────────────────────────────────────
//
// The outbox IS the reliability boundary (ADR-108, and the same shape as the audit and search
// outboxes): once a row is in `webhook_outbox`, the drain leases it, retries with backoff, and only
// deletes it after a 2xx or after exhausting its attempts. Delivery therefore survives a crash, a slow
// consumer, and a redeployment.
//
// What it does NOT survive is the process dying between `emit` and the INSERT below, because `emit` is
// synchronous-fire-and-forget by contract (packages/events: handlers are invoked through
// `void Promise.resolve(h(event))`). Two of the pre-existing enqueues — the ones in the publish path —
// ran inside the operation's own transaction and therefore did survive that window. They are kept
// exactly where they are for that reason; this bridge SKIPS the types they already carry rather than
// enqueueing them twice. A second road to the same delivery is how two answers to one question start
// disagreeing, so the skip is stated in one place, here, and pinned.
//
// ── what is NOT decided here ───────────────────────────────────────────────────────────────────────
//
// Whether an event may leave the tenant at all is the drain's question, not this one. `page-disposition`
// reads the CURRENT authorization state at delivery time and suppresses anything about a private page
// or an unpublished draft (ADR-108 Q4's existence-hiding rule) — which is why enqueueing every type is
// safe: a row for a draft page is written, and then dropped before it can reach anybody. Filtering here
// instead would ask the authorization store a question whose answer can change before delivery.
import type { DomainEvent } from '@wikistead/events'
import type { Sql } from 'postgres'
import { enqueueWebhookOutbox } from '../routes/webhooks.js'

/**
 * Event types that a call site already enqueues inside its own transaction.
 *
 * These are the ones whose delivery is worth more than the bridge can offer: the publish path writes
 * the row in the same transaction that publishes, so a crash cannot separate the two. The bridge would
 * add a second, weaker copy of the same event.
 */
export const ENQUEUED_IN_TRANSACTION = new Set<DomainEvent['type']>(['page.published', 'api_key.revoked'])

/** The delivered payload: everything the event carries except the routing fields the row already has. */
export function webhookPayload(event: DomainEvent): Record<string, unknown> {
  const { type: _type, tenantId: _tenantId, ...rest } = event as DomainEvent & Record<string, unknown>
  return { ...rest, occurredAt: new Date().toISOString() }
}

/**
 * Should this event be enqueued by the bridge?
 *
 * Separated from the subscriber so the rule can be measured without a database — the defect this
 * ticket is about was a wiring gap, and a test that can only reach it through a live outbox would have
 * had nothing to say about the seventy-three types that were never wired.
 */
export function bridgeShouldEnqueue(event: DomainEvent): boolean {
  return !ENQUEUED_IN_TRANSACTION.has(event.type)
}

/**
 * Enqueue one event, unless a transaction-scoped call site already did.
 *
 * Failures are reported to the caller rather than swallowed: the bus cannot retry, so a lost INSERT is
 * the one gap in this path and it should be visible in the logs of the process that lost it.
 */
export async function bridgeEventToOutbox(sql: Sql, event: DomainEvent): Promise<'enqueued' | 'skipped'> {
  if (!bridgeShouldEnqueue(event)) return 'skipped'
  await enqueueWebhookOutbox(sql, { tenantId: event.tenantId, eventType: event.type, payload: webhookPayload(event) })
  return 'enqueued'
}
