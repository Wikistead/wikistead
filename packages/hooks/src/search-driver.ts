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
