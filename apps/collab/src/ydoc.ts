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

// Save ydoc binary to Postgres and (conditionally) create a revision snapshot.
//
// 0-row UPDATE detection: RLS or a deleted/missing page causes the UPDATE
// to affect 0 rows. When stored=false: error is logged and pages.ydoc is not
// written. TODO: add retry / alert mechanism for persistent 0-row failures.
//
// Draft-only persistence (draft/publish model): this autosaves the live draft
// (pages.ydoc) so edits survive a tab close / restart. It deliberately does NOT
// create revisions or reindex search — those are tied to an explicit publish
// (POST /pages/:id/publish), so history is the publish history and search/export
// only ever reflect PUBLISHED content. A draft's in-progress text is never indexed.
export async function storeYdoc(
  tenantId: string,
  pageId: string,
  state: Uint8Array,
  _createdBy?: string,
): Promise<StoreResult> {
  let stored = false
  await withTenant(tenantId, async (tx) => {
    const result = await tx`
      UPDATE pages
      SET ydoc = ${Buffer.from(state)}, updated_at = now(), has_unpublished_changes = true
      WHERE id = ${pageId}
    `
    if (result.count === 0) {
      console.error(
        `[ydoc:store] 0-row UPDATE page:${pageId} tenant:${tenantId}` +
        ` — page not found or RLS mismatch; edits will NOT survive restart`,
      )
      return undefined
    }
    stored = true
    return undefined
  })
  return { stored }
}
