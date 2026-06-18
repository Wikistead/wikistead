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
}

export interface SearchDriver {
  ensureIndex(): Promise<void>
  search(params: {
    tenantId: string
    userId: string
    groups: string[]
    q: string
    spaceId?: string
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
