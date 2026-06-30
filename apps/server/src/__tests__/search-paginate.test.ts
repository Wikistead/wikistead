import { describe, it, expect } from 'vitest'
import { paginateAuthorized, fillAuthorizedPage, SEARCH_PAGE_SIZE, SEARCH_CANDIDATE_LIMIT } from '../search/paginate.js'
import type { SearchHit } from '@wikistead/hooks'

const hit = (id: string): SearchHit => ({ id, tenantId: 't', spaceId: 's', title: id })
const hits = (n: number): SearchHit[] => Array.from({ length: n }, (_, i) => hit(`p${i}`))
const windowOver = (all: SearchHit[]) => async (offset: number, limit: number) => all.slice(offset, offset + limit)
const authorizeOnly = (ok: Set<string>) => async (ids: string[]) => new Set(ids.filter((i) => ok.has(i)))

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

// #103 / ADR-068: the deep-pagination fill loop — the gap *fix* (reachable, not just signalled).
describe('fillAuthorizedPage', () => {
  it('surfaces an authorized hit PAST the first candidate window (the gap the old cap lost)', async () => {
    const all = hits(100) // 100 ranked candidates; only p75 is authorized — beyond a 60-wide window
    const { results } = await fillAuthorizedPage(windowOver(all), authorizeOnly(new Set(['p75'])), { pageSize: 20, windowSize: 20, maxScan: 200 })
    expect(results.map((h) => h.id)).toEqual(['p75']) // reachable; the old single-window code lost it
  })

  it('never returns an FGA-unconfirmed hit; preserves rank order', async () => {
    const all = hits(40)
    const { results } = await fillAuthorizedPage(windowOver(all), authorizeOnly(new Set(['p2', 'p0', 'p9'])), { pageSize: 20, windowSize: 10 })
    expect(results.map((h) => h.id)).toEqual(['p0', 'p2', 'p9']) // only authorized, in candidate order
  })

  it('bounds the scan (no DoS) for a no-authz user and hands back a resume cursor', async () => {
    let calls = 0
    const counting = async (offset: number, limit: number) => { calls++; return hits(1000).slice(offset, offset + limit) }
    const { results, nextCursor } = await fillAuthorizedPage(counting, authorizeOnly(new Set()), { pageSize: 20, windowSize: 20, maxScan: 200 })
    expect(results).toEqual([])           // nothing authorized
    expect(nextCursor).toBe(200)          // bounded at maxScan, reachable via cursor
    expect(calls).toBeLessThanOrEqual(10) // 200/20 windows — not the whole 1000-candidate stream
  })

  it('stops with no cursor when the candidate stream is exhausted (short last window)', async () => {
    const all = hits(15) // fewer than one window
    const { results, nextCursor } = await fillAuthorizedPage(windowOver(all), authorizeOnly(new Set(['p1'])), { pageSize: 20, windowSize: 20 })
    expect(results.map((h) => h.id)).toEqual(['p1'])
    expect(nextCursor).toBeNull() // no more candidates
  })

  it('resumes from startOffset (cursor continuation)', async () => {
    const seen: number[] = []
    const rec = async (offset: number, limit: number) => { seen.push(offset); return hits(100).slice(offset, offset + limit) }
    await fillAuthorizedPage(rec, authorizeOnly(new Set(['p50'])), { startOffset: 40, pageSize: 20, windowSize: 20, maxScan: 60 })
    expect(seen[0]).toBe(40) // first window fetched at the cursor, not 0
  })

  // #103 / ADR-068 side-channel (B1/B2): the resume signal must not become an existence oracle. The
  // cursor itself is opaque + scope-bound (search-cursor.test); these assert the FILL-loop signal.
  it('B1: a budget-exhausted unauthorized scan and an authorized-tail-past-budget scan are INDISTINGUISHABLE (same cursor, empty page)', async () => {
    const stream = hits(1000) // identical candidate stream (stage-1 is the same query for everyone)
    const opts = { pageSize: 20, windowSize: 20, maxScan: 200 }
    // unauthorized viewer: authorize() returns nothing → empty page, budget cursor.
    const unauth = await fillAuthorizedPage(windowOver(stream), authorizeOnly(new Set()), opts)
    // a viewer whose only authorized hit sits PAST the budget → also empty page, budget cursor.
    const tail = await fillAuthorizedPage(windowOver(stream), authorizeOnly(new Set(['p900'])), opts)
    expect(unauth.results).toEqual([])
    expect(tail.results).toEqual([])
    expect(unauth.nextCursor).not.toBeNull()
    expect(unauth.nextCursor).toBe(tail.nextCursor) // same resume offset → "budget" vs "more beyond" not distinguishable
  })

  it('B2: an unauthorized viewer page/cursor does NOT depend on how many hits are authorized for OTHERS', async () => {
    const opts = { pageSize: 20, windowSize: 20, maxScan: 200 }
    // Same candidate stream; this viewer's authorize() is empty regardless of others' grants. Whether
    // the stream is "rich in others' authorized docs" or "sparse", this viewer sees the SAME output —
    // so results/cursor carry no trace of authorized-for-others existence.
    const out = await fillAuthorizedPage(windowOver(hits(1000)), authorizeOnly(new Set()), opts)
    const again = await fillAuthorizedPage(windowOver(hits(1000)), authorizeOnly(new Set()), opts)
    expect(out).toEqual({ results: [], nextCursor: 200 })
    expect(again).toEqual(out) // deterministic; the only viewer-visible signal is the budget bound
  })
})
