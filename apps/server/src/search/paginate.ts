import type { SearchHit } from '@wikistead/hooks'

// ADR-027: two-stage search pages AFTER the FGA confirmation, not before.
//
// Stage 1 (Meilisearch) over-fetches CANDIDATES; stage 2 (filterAuthorized / OpenFGA)
// confirms them. If we capped stage 1 at the page size and only then FGA-filtered, an
// unauthorized hit inside the first page would shrink the visible page even though more
// authorized hits exist just past the cutoff (the "authorized-hit gap" — results silently
// missing, though never leaked). Over-fetching and paging the *authorized* set closes that.
//
// Invariants (per the approval on #24):
//  - Never return an FGA-unconfirmed hit: results are filtered by `authorized` FIRST; raw
//    candidates are used only as input and never returned.
//  - Never silently cap: `hasMore` signals that more authorized results may exist (either we
//    trimmed authorized hits, or stage 1 itself was capped at the candidate limit so more
//    could lie beyond what we fetched). `K` (the over-fetch factor) is a perf knob, not a
//    correctness one — completeness is conveyed by `hasMore`.
//  - Relevance order is preserved: candidates arrive ranked; filter + slice keep that order.

export const SEARCH_PAGE_SIZE = 20
export const SEARCH_CANDIDATE_LIMIT = 60 // stage-1 over-fetch = PAGE_SIZE * 3
// #103 / ADR-068: per-request scan budget for deep pagination. Bounds Meili reads + FGA checks
// per request regardless of how sparse the user's authz is (no DoS-by-search); the cursor carries
// the rest across requests so a sparse-authz tail stays REACHABLE (not just signalled).
export const SEARCH_MAX_SCAN = SEARCH_PAGE_SIZE * 10 // 200 candidates / request

export function paginateAuthorized(
  candidates: SearchHit[],
  authorized: Set<string>,
  pageSize: number = SEARCH_PAGE_SIZE,
  candidateLimit: number = SEARCH_CANDIDATE_LIMIT,
): { results: SearchHit[]; hasMore: boolean } {
  const authed = candidates.filter((h) => authorized.has(h.id)) // FGA-confirmed only
  const results = authed.slice(0, pageSize)
  const hasMore = authed.length > pageSize || candidates.length >= candidateLimit
  return { results, hasMore }
}

// #103 / ADR-068: fill a page of AUTHORIZED hits by scanning ranked candidate windows under a
// bounded budget, so an authorized hit sitting PAST the first candidate window is still reachable
// (the gap paginateAuthorized only signalled). `fetchWindow(offset,limit)` returns the next ranked
// candidates; `authorize(ids)` returns the FGA-confirmed subset. Loops until `pageSize` authorized
// accumulate OR the candidate stream / scan budget is exhausted. Returns the authorized page + an
// opaque `nextCursor` (the offset to resume at) when more MAY exist, else null.
//
// Invariants: never returns an FGA-unconfirmed hit (only `authorize`d ids pass); relevance order
// preserved (windows fetched in rank order, appended); cost bounded by `maxScan` per request
// (the sparse-authz / no-authz case pays a fixed ceiling, then continues via the cursor — no
// DoS-by-search, no infinite scan).
export async function fillAuthorizedPage(
  fetchWindow: (offset: number, limit: number) => Promise<SearchHit[]>,
  authorize: (ids: string[]) => Promise<Set<string>>,
  opts: { startOffset?: number; pageSize?: number; windowSize?: number; maxScan?: number } = {},
): Promise<{ results: SearchHit[]; nextCursor: number | null }> {
  const pageSize = opts.pageSize ?? SEARCH_PAGE_SIZE
  const windowSize = opts.windowSize ?? SEARCH_CANDIDATE_LIMIT
  const maxScan = opts.maxScan ?? SEARCH_MAX_SCAN
  let offset = Math.max(0, opts.startOffset ?? 0)
  const results: SearchHit[] = []
  let scanned = 0

  while (results.length < pageSize && scanned < maxScan) {
    const window = await fetchWindow(offset, windowSize)
    if (window.length === 0) return { results, nextCursor: null } // candidate stream exhausted
    const authed = await authorize(window.map((h) => h.id))
    for (const h of window) if (authed.has(h.id) && results.length < pageSize) results.push(h)
    offset += window.length
    scanned += window.length
    if (window.length < windowSize) return { results, nextCursor: null } // short window = last page
  }
  // Stopped on a full page or the scan budget — more may lie beyond; hand back a resume cursor.
  return { results, nextCursor: offset }
}
