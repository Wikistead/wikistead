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
