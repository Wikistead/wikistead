import type { Sql } from 'postgres'
import { pool } from '../db/pool.js'
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
// Failed entries remain in search_outbox for retry.
// TODO(phase: search): add a background worker or pnpm search:sync script to
//   drain stale outbox entries when Meilisearch recovers from downtime.
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
    } catch {
      // Leave entry in outbox. Caller already received API success.
    }
  })()
}
