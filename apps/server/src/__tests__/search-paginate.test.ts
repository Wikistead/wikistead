import { describe, it, expect } from 'vitest'
import { paginateAuthorized, SEARCH_PAGE_SIZE, SEARCH_CANDIDATE_LIMIT } from '../search/paginate.js'
import type { SearchHit } from '@wikistead/hooks'

const hit = (id: string): SearchHit => ({ id, tenantId: 't', spaceId: 's', title: id })

// ADR-027 / #24: page after the FGA filter. authz-critical → assert both directions.
describe('paginateAuthorized', () => {
  it('never returns an FGA-unconfirmed candidate (no leak)', () => {
    const candidates = [hit('a'), hit('b'), hit('c')]
    const { results } = paginateAuthorized(candidates, new Set(['a', 'c']), 10, 10)
    expect(results.map((h) => h.id)).toEqual(['a', 'c']) // 'b' (unauthorized) excluded
  })

  it('surfaces an authorized hit that sits past the unauthorized ones (the gap fix)', () => {
    // First two candidates are unauthorized; the authorized one is third. With pageSize 2 it
    // must still appear (over-fetch + page-after-filter), not be lost to the stage-1 cutoff.
    const candidates = [hit('x1'), hit('x2'), hit('ok')]
    const { results } = paginateAuthorized(candidates, new Set(['ok']), 2, 10)
    expect(results.map((h) => h.id)).toEqual(['ok'])
  })

  it('trims to pageSize and preserves rank order', () => {
    const candidates = ['a', 'b', 'c', 'd'].map(hit)
    const { results } = paginateAuthorized(candidates, new Set(['a', 'b', 'c', 'd']), 2, 10)
    expect(results.map((h) => h.id)).toEqual(['a', 'b'])
  })

  it('hasMore=true when authorized hits exceed pageSize', () => {
    const candidates = ['a', 'b', 'c'].map(hit)
    const { hasMore } = paginateAuthorized(candidates, new Set(['a', 'b', 'c']), 2, 10)
    expect(hasMore).toBe(true)
  })

  it('hasMore=true when stage-1 was capped at the candidate limit (more may lie beyond)', () => {
    const candidates = Array.from({ length: 5 }, (_, i) => hit(`c${i}`))
    const { hasMore } = paginateAuthorized(candidates, new Set(['c0']), 10, 5) // candidates.length === limit
    expect(hasMore).toBe(true)
  })

  it('hasMore=false when nothing was trimmed and stage-1 was not capped', () => {
    const candidates = ['a', 'b'].map(hit)
    const { hasMore } = paginateAuthorized(candidates, new Set(['a', 'b']), 10, 60)
    expect(hasMore).toBe(false)
  })

  it('default constants are sane (candidate limit over-fetches the page)', () => {
    expect(SEARCH_CANDIDATE_LIMIT).toBeGreaterThan(SEARCH_PAGE_SIZE)
  })
})
