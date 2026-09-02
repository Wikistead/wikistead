import type { Sql } from 'postgres'

// ADR-252 §1 / "Both operations" / #810: the storage keys `tenant_sweep_manifests.storage_keys` must
// hold before a reset destroys anything — "every S3 key a swept row points at", derived from the
// KEY-BEARING COLUMNS, not from a key shape that happens to embed the tenant id (rev 4's rule, replaced
// in rev 5: space icons and member avatars do not carry the tenant id in their key text).
//
// Scoped to §1 (tenant:reset) specifically, not the full 7-column list "Both operations" names for
// BOTH operations combined. `members.avatar_image_key` and `tenant_settings.logo_key` are excluded
// here: a reset keeps the tenant's members and its own settings row (§1's decision — "keeps its row,
// its slug, its members, its login configuration"), so neither survives a delete in the first place.
// A future §2 (full removal) slice adds those two when it is built; naming them here as "not yet
// wired" rather than silently omitting them keeps the gap visible.

export interface DoomedIds {
  // ⚠️ §1: "for a kept space it keeps the space, its settings, and its share links; it EMPTIES THE
  // PAGES INSIDE" — a kept space's pages are swept too. `spaceIds` and `pageIds` are therefore NOT
  // the same "which spaces are doomed" filter applied twice; they answer two different questions.
  /** spaces NOT on the keep-list — the SPACE ROW (and `space_settings`, its icon key) is swept.
   * A kept space's own id does not belong here even though its pages do belong in `pageIds` below. */
  spaceIds: readonly string[]
  /** EVERY page reset empties — every space's pages, keep-listed or not. A kept space keeps its row
   * and settings, never its pages. */
  pageIds: readonly string[]
}

export async function collectResetStorageKeys(sql: Sql, tenantId: string, doomed: DoomedIds): Promise<string[]> {
  const keys: string[] = []

  if (doomed.pageIds.length > 0) {
    const attachments = await sql<{ s3_key: string }[]>`
      SELECT s3_key FROM attachments WHERE tenant_id = ${tenantId} AND page_id = ANY(${doomed.pageIds})`
    keys.push(...attachments.map((r) => r.s3_key))

    const revisions = await sql<{ ydoc_key: string }[]>`
      SELECT ydoc_key FROM revisions
      WHERE tenant_id = ${tenantId} AND page_id = ANY(${doomed.pageIds}) AND ydoc_key IS NOT NULL`
    keys.push(...revisions.map((r) => r.ydoc_key))
  }

  if (doomed.spaceIds.length > 0) {
    const icons = await sql<{ icon_image_key: string }[]>`
      SELECT icon_image_key FROM space_settings
      WHERE tenant_id = ${tenantId} AND space_id = ANY(${doomed.spaceIds}) AND icon_image_key IS NOT NULL`
    keys.push(...icons.map((r) => r.icon_image_key))

    const archives = await sql<{ archive_key: string }[]>`
      SELECT archive_key FROM imports
      WHERE tenant_id = ${tenantId} AND space_id = ANY(${doomed.spaceIds}) AND archive_key IS NOT NULL`
    keys.push(...archives.map((r) => r.archive_key))
  }

  // ⚠️ `revision_gc_candidates` (migration 034) is DELIBERATELY NOT queried here, even though ADR-252
  // names its `ydoc_key` column. That table has no `tenant_id` column at all (it is admin/GC-internal
  // bookkeeping, keyed only by the storage key text — `revisions/${tenantId}/${uuid}`, revision-ydoc.ts)
  // and carries no page linkage — a row in it is, by construction, a blob whose live `revisions` row is
  // ALREADY GONE. For a KEEP-LIST reset there is no way to tell whether an orphaned blob's original page
  // was in a kept space or a doomed one — the linkage that would answer that was lost when it became a
  // candidate. Sweeping it here would over-reach into a kept space's history; leaving it alone under-
  // reaches, but not unsafely: `revisions-gc.ts` runs independently on its own schedule and will still
  // delete it. A whole-tenant removal (§2, not yet built) has no such ambiguity — every row is doomed —
  // and can safely prefix-match `revisions/${tenantId}/%` when it is implemented.
  return keys
}
