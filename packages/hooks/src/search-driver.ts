// CE-published extension point for search.
// EE registers an alternative SearchDriver (semantic search, RAG, etc.).
// CE uses the LogicalSearchDriver as the default when none is registered.
//
// SearchDriver is defined here (not in apps/server) so EE can implement it
// without importing from CE's application layer.
import type { SearchDoc } from '@wikistead/types'

export interface SearchHit {
  id: string
  tenantId: string
  spaceId: string
  title: string
  // Cropped plain-text excerpt of the body around the match (P2). PLAIN text only
  // (no highlight markup) so the UI can render it as text — no XSS surface for what
  // is, after all, user-authored content. Present only for hits that pass the
  // two-stage guard; never returned for a result the FGA stage drops.
  snippet?: string
}

export interface SearchDriver {
  ensureIndex(): Promise<void>
  search(params: {
    tenantId: string
    userId: string
    groups: string[]
    q: string
    spaceId?: string
    // #103 / ADR-068: deep pagination. `offset` resumes a ranked candidate scan; `limit` sizes
    // the window. Both optional — omitting them yields the first default-sized candidate window
    // (backward compatible). The caller (two-stage search) loops windows under a scan budget.
    offset?: number
    limit?: number
    // #449 / ADR-173: a GUEST candidate scan. Stage 1 is performance, never the fortress
    // (ADR-027) — for a share-link guest the viewer denormalization does not carry them (the
    // doc-builder excludes share_link principals), so the candidate filter drops the viewer terms
    // and keeps only tenant + space. Everything the guest must not see (private / trashed / draft /
    // other spaces) is cut by the AUTHORITATIVE stage-2 FGA check on the share_link principal — the
    // caller MUST pass a space scope AND run that check; this flag only widens stage 1.
    omitViewerFilter?: boolean
  }): Promise<SearchHit[]>
  upsertDoc(doc: SearchDoc): Promise<void>
  deleteDoc(pageId: string): Promise<void>
}

let _driver: SearchDriver | null = null

export function registerSearchDriver(driver: SearchDriver): void {
  _driver = driver
}

export function getSearchDriver(fallback: SearchDriver): SearchDriver {
  return _driver ?? fallback
}
