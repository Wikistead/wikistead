// #353 / ADR-027 (authorized-hit gap, Hole C): the reverse-lookup lists must not DROP viewable results at the
// raw-fetch boundary. The naive `LIMIT N` raw → per-item view-filter loses authorized rows when the top N by
// rank include non-viewable ones. getBacklinks / getListResults(children) now OVER-FETCH past the display cap,
// view-filter in rank order, and stop at the display cap (top-N VIEWABLE by rank). These are FAST unit tests
// (fake db + fga — the real-Postgres path is covered by backlinks.test.ts / tagged-children-370.test.ts): building 600
// real pages per run to exercise a boundary is not worth the CI cost, so the boundary/early-exit is pinned here.
import { describe, it, expect } from 'vitest'
import { getBacklinks, getListResults } from '../routes/pages.js'

const DISPLAY_N = 200

// A fake fga whose `check` says a `page:<id>` is viewable iff `viewable(id)`. It counts ROUND-TRIPS, which
// is the thing the boundary design is spending: `calls` gets one entry per single check and one per batch.
// The FIRST check is the target / parent gate (always allowed here).
//
// #623: getBacklinks confirms in ONE batched question now instead of one per candidate, so this stub grew a
// `batchCheck` — the claims below (top-N viewable by rank, no boundary drop) are unchanged, and the cost
// claim got stronger: it used to be "at most DISPLAY_N round-trips", it is now a handful.
function fakeFga(viewable: (id: string) => boolean) {
  const calls: string[] = []
  const fga = {
    check: async (req: { object: string }) => {
      const id = req.object.replace(/^page:/, '')
      calls.push(id)
      return { allowed: viewable(id) }
    },
    batchCheck: async ({ checks }: { checks: { object: string; correlationId: string }[] }) => {
      calls.push(`batch:${checks.length}`)
      return { result: checks.map((c) => ({ correlationId: c.correlationId, allowed: viewable(c.object.replace(/^page:/, '')) })) }
    },
  } as never
  return { fga, calls }
}

// A fake db returning the given rows for the single tagged-template query getBacklinks/children run.
function fakeDb(rows: unknown[]) {
  return { sql: async () => rows } as never
}

describe('getBacklinks Hole C: over-fetch + rank-drop + top-N (#353 / ADR-027)', () => {
  const target = 'T'
  // Every row is a REAL backlink (its body links /p/T so the reference regex matches); rank = array order.
  const rowsAllViewable = Array.from({ length: 250 }, (_, i) => ({ id: `p${i}`, title: `P${i}`, published_md: `/p/${target}` }))

  it('returns exactly the top DISPLAY_N by rank when more than DISPLAY_N are viewable (no unbounded growth)', async () => {
    const { fga, calls } = fakeFga(() => true)
    const out = await getBacklinks(fakeDb(rowsAllViewable), fga, { pageId: target, subject: 'user:u' })
    expect(out.length).toBe(DISPLAY_N)
    expect(out[0]!.id).toBe('p0') // rank order preserved (top of the list)
    expect(out[DISPLAY_N - 1]!.id).toBe(`p${DISPLAY_N - 1}`)
    // #623: 1 target gate + a handful of BATCHES for 250 candidates — not 250 round-trips, and not the
    // 200 the early-exiting loop cost before. The panel's wait stopped scaling with the neighbourhood.
    expect(calls.filter((c) => !c.startsWith('batch:')).length, 'one single check: the target gate').toBe(1)
    expect(calls.length, 'and a few batches, not one question per candidate').toBeLessThan(10)
    expect(calls.some((c) => c.startsWith('batch:')), 'the confirm really was batched').toBe(true)
  })

  it('does NOT drop viewable hits at the boundary: 60 non-viewable ahead of 200 viewable still yields 200', async () => {
    // The first 60 (by rank) are non-viewable; the naive `LIMIT 200 → filter` would return only ~140. Over-fetch
    // means all 200 genuine hits survive. (Rows here total 260 — within the 600 over-fetch the real DB would return.)
    const rows = [
      ...Array.from({ length: 60 }, (_, i) => ({ id: `hidden${i}`, title: `H${i}`, published_md: `/p/${target}` })),
      ...Array.from({ length: 200 }, (_, i) => ({ id: `ok${i}`, title: `OK${i}`, published_md: `/p/${target}` })),
    ]
    const { fga } = fakeFga((id) => id === target || id.startsWith('ok'))
    const out = await getBacklinks(fakeDb(rows), fga, { pageId: target, subject: 'user:u' })
    expect(out.length).toBe(DISPLAY_N) // full display cap of VIEWABLE hits, not short of it
    expect(out.every((l) => l.id.startsWith('ok'))).toBe(true)
  })

  it('a non-viewable TARGET is a uniform 404 before any fetch (existence-hiding, unchanged)', async () => {
    const { fga } = fakeFga(() => false) // even the target gate denies
    await expect(getBacklinks(fakeDb(rowsAllViewable), fga, { pageId: target, subject: 'user:u' }))
      .rejects.toMatchObject({ statusCode: 404 })
  })
})

describe('getListResults children Hole C: over-fetch + top-N (#353→#370 / ADR-027)', () => {
  const parent = 'PARENT'
  it('returns top DISPLAY_N viewable children by rank and early-exits the view loop', async () => {
    // #370children is now the descendant TREE — the fake rows carry the recursive-CTE columns
    // (parent_id/published/position/depth). 250 direct children of the parent, pre-order = position order.
    const rows = Array.from({ length: 250 }, (_, i) => ({ id: `c${i}`, title: `C${i}`, parent_id: parent, published: true, position: i, depth: 1 }))
    const { fga, calls } = fakeFga(() => true)
    const out = await getListResults(fakeDb(rows), fga, { pageId: parent, name: 'children', body: '', subject: 'user:u' })
    expect(out.length).toBe(DISPLAY_N)
    expect(out[0]).toMatchObject({ id: 'c0', depth: 0 }) // emitted depth is result-tree-relative (top level = 0)
    expect(calls.length).toBe(1 + DISPLAY_N) // 1 parent gate + DISPLAY_N child checks (early-exit)
  })
})
