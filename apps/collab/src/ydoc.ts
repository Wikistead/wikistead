// Ydoc persistence: load and store Y.Doc binary state in Postgres.
// All DB access goes through withTenant() so RLS applies; cross-tenant
// operations are blocked at the DB level and detected via 0-row result.
import { withTenant } from './db.js'

export async function loadYdoc(tenantId: string, pageId: string): Promise<Uint8Array | null> {
  let result: Uint8Array | null = null
  await withTenant(tenantId, async (tx) => {
    const [row] = await tx<[{ ydoc: Buffer | null }]>`
      SELECT ydoc FROM pages WHERE id = ${pageId}
    `
    if (row?.ydoc) result = new Uint8Array(row.ydoc)
    return undefined
  })
  return result
}

export interface StoreResult {
  stored: boolean
}

// Save ydoc binary to Postgres and enqueue a search reindex.
//
// 0-row UPDATE detection: RLS (or a deleted/missing page) causes the UPDATE
// to affect 0 rows instead of throwing. This is correct safety behaviour —
// cross-tenant writes silently fail — but it means user edits are NOT being
// persisted and will be lost on Hocuspocus restart.
//
// When stored=false: an error is logged and no outbox entry is written
// (no point reindexing a page that doesn't exist or can't be written to).
// TODO: add retry / alert mechanism for persistent 0-row failures.
export async function storeYdoc(
  tenantId: string,
  pageId: string,
  state: Uint8Array,
): Promise<StoreResult> {
  let stored = false
  await withTenant(tenantId, async (tx) => {
    const result = await tx`
      UPDATE pages
      SET ydoc = ${Buffer.from(state)}, updated_at = now()
      WHERE id = ${pageId}
    `
    if (result.count === 0) {
      console.error(
        `[ydoc:store] 0-row UPDATE page:${pageId} tenant:${tenantId}` +
        ` — page not found or RLS mismatch; edits will NOT survive restart`,
      )
      return undefined  // early return: outbox INSERT skipped
    }
    // Enqueue body reindex only when ydoc was actually persisted.
    await tx`
      INSERT INTO search_outbox (tenant_id, page_id, operation)
      VALUES (${tenantId}, ${pageId}, 'upsert')
    `
    stored = true
    return undefined
  })
  return { stored }
}
