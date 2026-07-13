// #353 / ADR-027 (authorized-hit gap, Hole C): the reverse-lookup lists must not DROP viewable results at the
// raw-fetch boundary. The naive `LIMIT N` raw → per-item view-filter loses authorized rows when the top N by
// rank include non-viewable ones. getBacklinks / getQueryResults(children) now OVER-FETCH past the display cap,
// view-filter in rank order, and stop at the display cap (top-N VIEWABLE by rank). These are FAST unit tests
// (fake db + fga — the real-Postgres path is covered by backlinks.test.ts / query-134.test.ts): building 600
// real pages per run to exercise a boundary is not worth the CI cost, so the boundary/early-exit is pinned here.
import { describe, it, expect } from 'vitest'
import { getBacklinks, getQueryResults } from '../routes/pages.js'

const DISPLAY_N = 200

// A fake fga whose `check` says a `page:<id>` is viewable iff `viewable(id)`; it counts calls so we can assert
// the per-item loop early-exits at DISPLAY_N (does not scan the whole over-fetch). The FIRST check is the target
// / parent gate (always allowed here).
function fakeFga(viewable: (id: string) => boolean) {
  const calls: string[] = []
  const fga = {
    check: async (req: { object: string }) => {
      const id = req.object.replace(/^page:/, '')
      calls.push(id)
      return { allowed: viewable(id) }
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
    // early-exit: 1 target gate + DISPLAY_N per-item checks — NOT all 250 candidates.
    expect(calls.length).toBe(1 + DISPLAY_N)
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

describe('getQueryResults children Hole C: over-fetch + top-N (#353 / ADR-027)', () => {
  const parent = 'PARENT'
  it('returns top DISPLAY_N viewable children by rank and early-exits the view loop', async () => {
    const rows = Array.from({ length: 250 }, (_, i) => ({ id: `c${i}`, title: `C${i}` }))
    const { fga, calls } = fakeFga(() => true)
    const out = await getQueryResults(fakeDb(rows), fga, { pageId: parent, spec: { type: 'children' }, subject: 'user:u' })
    expect(out.length).toBe(DISPLAY_N)
    expect(calls.length).toBe(1 + DISPLAY_N) // 1 parent gate + DISPLAY_N child checks (early-exit)
  })
})
