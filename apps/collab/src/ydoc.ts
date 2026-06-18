// Ydoc persistence: load and store Y.Doc binary state in Postgres.
// All DB access goes through withTenant() so RLS applies; cross-tenant
// operations are blocked at the DB level and detected via 0-row result.
import { withTenant } from './db.js'

// Minimum elapsed time between automatic revision snapshots per page.
// Prevents every-debounce flooding while preserving meaningful history.
// Override with REVISION_INTERVAL_MINUTES env var.
const REVISION_INTERVAL_MS =
  Number(process.env.REVISION_INTERVAL_MINUTES ?? 5) * 60_000

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

// Save ydoc binary to Postgres and (conditionally) create a revision snapshot.
//
// 0-row UPDATE detection: RLS or a deleted/missing page causes the UPDATE
// to affect 0 rows. When stored=false: error is logged and neither the
// pages.ydoc nor the revision is written.
// TODO: add retry / alert mechanism for persistent 0-row failures.
//
// Revision insertion policy:
//   Only inserts when >= REVISION_INTERVAL_MINUTES have elapsed since the last
//   revision for this page. The restore handler bypasses this check and always
//   inserts directly (so restored state is immediately undoable).
export async function storeYdoc(
  tenantId: string,
  pageId: string,
  state: Uint8Array,
  createdBy?: string,
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
      return undefined
    }

    // Interval-gated revision: check time since last snapshot for this page.
    const [last] = await tx<[{ created_at: Date }]>`
      SELECT created_at FROM revisions
      WHERE page_id = ${pageId}
      ORDER BY created_at DESC LIMIT 1
    `
    const elapsed = last ? Date.now() - last.created_at.getTime() : Infinity
    if (elapsed >= REVISION_INTERVAL_MS) {
      await tx`
        INSERT INTO revisions (tenant_id, page_id, ydoc, title, created_by)
        SELECT ${tenantId}, ${pageId}, ${Buffer.from(state)}, title, ${createdBy ?? null}
        FROM pages WHERE id = ${pageId}
      `
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
