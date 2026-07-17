import type { Sql } from 'postgres'
import { pool } from '../db/pool.js'
import { claimOutboxBatch, startOutboxDrainWorker } from '../db/outbox-lease.js' // #432
import { fgaClient } from '@wikistead/authz'
import { buildSearchDoc } from './doc-builder.js'
import type { SearchDriver } from './driver.js'

export interface OutboxEntry {
  tenantId: string
  pageId: string
  operation: 'upsert' | 'delete'
}

// Write to outbox. Call inside the same DB transaction as the FGA/DB change
// so the reindex intent is atomically recorded with the permission change.
// Returns the outbox entry ID for use with processOutboxAsync.
export async function enqueueOutbox(sql: Sql, entry: OutboxEntry): Promise<string> {
  const [{ id }] = await sql<[{ id: string }]>`
    INSERT INTO search_outbox (tenant_id, page_id, operation)
    VALUES (${entry.tenantId}, ${entry.pageId}, ${entry.operation})
    RETURNING id
  `
  return id
}

// Fire-and-forget outbox processor. Returns immediately — does NOT block
// the calling request. Meili failure is a latency problem, not a safety problem;
// the FGA final check in GET /search is the authoritative safety gate.
//
// Deletion order invariant: outbox entry is deleted ONLY after Meili confirms
// success. At-least-once semantics: a crash between Meili success and outbox
// delete causes harmless reprocessing (Meili upsert/delete is idempotent).
//
// Failed entries remain in search_outbox for retry — drained by the background
// worker below (drainOutbox / startOutboxWorker).

interface ClaimedRow { id: string; tenant_id: string; page_id: string; operation: 'upsert' | 'delete' }

// #224 / ADR-104 Addendum 3 Finding B: the title-dictionary SECURITY-TIMING invalidation rides this
// SAME trusted outbox path (never best-effort enqueue): every page mutation that reaches the outbox
// (privatise / delete / rename / publish — they all enqueue for the search reindex already) also
// publishes `wks:dict:<tenantId>` after the reindex succeeds, so connected clients drop the title
// from their in-memory dictionary and the colored link disappears within the window. The publisher
// is injected from buildApp (the valkey client lives there); tests without valkey → no-op, and the
// client refetch is the backstop (latency, never correctness — the dictionary endpoint itself stays
// the authority).
export const DICT_CHANNEL_PREFIX = 'wks:dict:'
let dictInvalidatePublisher: ((tenantId: string, pageId: string) => void) | null = null
export function setDictInvalidatePublisher(fn: ((tenantId: string, pageId: string) => void) | null): void {
  dictInvalidatePublisher = fn
}
function publishDictInvalidate(tenantId: string, pageId: string): void {
  try { dictInvalidatePublisher?.(tenantId, pageId) } catch { /* publish is liveness only */ }
}

// Background drain worker. Claims a batch of pending outbox rows and reindexes
// them. This is what makes COLLAB body edits searchable: the collab server only
// enqueues an 'upsert' on Y.Doc store; nothing else drains it (processOutboxAsync
// runs inline only for API mutations). It also retries any inline failure.
//
// Single-winner across API instances: the claim UPDATE locks its candidate rows
// with FOR UPDATE SKIP LOCKED, so concurrent workers take disjoint batches; a row
// a crashed worker claimed but never finished is re-claimed after the stale window.
// RELIABLE, not best-effort: success → delete the row; failure → leave it (its
// claim ages out and it's retried). Idempotent with the inline path + itself
// (Meili upsert/delete are idempotent), so double processing is harmless.
export async function drainOutbox(driver: SearchDriver, opts: { batch?: number } = {}): Promise<number> {
  // #432: the claim statement / stale window live in the shared lease primitive.
  const claimed = await claimOutboxBatch<ClaimedRow>({
    table: 'search_outbox',
    returning: ['id', 'tenant_id', 'page_id', 'operation'],
    batch: opts.batch ?? 50,
  })
  let processed = 0
  for (const row of claimed) {
    try {
      if (row.operation === 'upsert') {
        const doc = await buildSearchDoc(pool, fgaClient, row.page_id, row.tenant_id)
        if (doc) await driver.upsertDoc(doc)
        else await driver.deleteDoc(row.page_id)
      } else {
        await driver.deleteDoc(row.page_id)
      }
      await pool`DELETE FROM search_outbox WHERE id = ${row.id}`
      publishDictInvalidate(row.tenant_id, row.page_id) // #224: dictionary security-timing signal
      processed++
    } catch {
      // Leave the row: its claim ages past the stale window and it is retried. The
      // request/edit already succeeded; search freshness catches up.
    }
  }
  return processed
}

// Start the periodic drain (call from the server entry, NOT buildApp — tests drive
// drainOutbox directly, so no stray timer leaks into app.inject). The in-process
// `running` guard prevents overlap within one instance; SKIP LOCKED handles across.
export function startOutboxWorker(driver: SearchDriver, intervalMs = 2000): () => void {
  return startOutboxDrainWorker(() => drainOutbox(driver), intervalMs) // #432: the shared loop
}

export function processOutboxAsync(
  driver: SearchDriver,
  outboxId: string,
  entry: OutboxEntry,
): void {
  void (async () => {
    try {
      if (entry.operation === 'upsert') {
        const doc = await buildSearchDoc(pool, fgaClient, entry.pageId, entry.tenantId)
        if (doc) {
          await driver.upsertDoc(doc)
        } else {
          // Page no longer exists: remove stale Meili doc if present.
          await driver.deleteDoc(entry.pageId)
        }
      } else {
        await driver.deleteDoc(entry.pageId)
      }
      // Delete outbox entry only after confirming Meili success.
      await pool`DELETE FROM search_outbox WHERE id = ${outboxId}`
      publishDictInvalidate(entry.tenantId, entry.pageId) // #224: dictionary security-timing signal
    } catch {
      // Leave entry in outbox. Caller already received API success.
    }
  })()
}
