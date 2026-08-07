// #545 (same defect as #540): GET /public/pages fed OpenFGA's ListObjects — which truncates SILENTLY at
// the server's max results (1000 by default) and spans the whole shared store — straight into the tenant
// listing. Once every tenant's public pages together passed the ceiling, a tenant's public page listing
// dropped entries non-deterministically (whichever ids the server happened to return first).
//
// A real 1000-public-page fixture would poison the shared store, so this drives listPublicPages through
// STUBS shaped like the real clients (the #540 pin's approach): listObjects answers with exactly the
// truncation-floor number of ids, batchCheck answers per its own public set. The ceiling pins were
// verified red against the pre-fix flow; below the floor the original one-call flow is pinned unchanged.
//
// #623 re-aimed these: the claim is unchanged — every public page of the tenant is REACHABLE, including
// the ones the store-wide cut dropped — but the answer is now a window at a time, so the pins walk the
// cursor instead of reading one unbounded response. The stubs honour the window (keyset, DESC, with an id
// tiebreaker) exactly as the SQL does, so a walk that loops or skips shows up here rather than in
// production; and each response is asserted BOUNDED, which is what the ticket is about.
import { describe, it, expect } from 'vitest'
import { listPublicPages, type PublicPageWindow, type PublicListRow } from '../routes/public.js'
import type { fgaClient } from '../authz.js'

const FLOOR = 1000
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

/** The keyset the SQL applies, in JS, so the stub can be walked the way the database would be. */
function windowOf(rows: PublicListRow[], win: PublicPageWindow): PublicListRow[] {
  // #623: an epoch numeric, the same shape the route's cursor now carries. The sort still needs a
  // string that orders like the timestamp, so it is padded — a bare number sorts '9' after '10'.
  const key = (r: PublicListRow) =>
    `${String(new Date(r.created_at).getTime() / 1000).padStart(20, '0')}|${r.id}`
  const sorted = [...rows].sort((a, b) => (key(a) < key(b) ? 1 : -1)) // created_at DESC, id DESC
  const from = win.after
    ? sorted.findIndex((r) => key(r) === `${String(win.after!.createdAt).padStart(20, '0')}|${win.after!.id}`) + 1
    : 0
  return sorted.slice(from, from + win.limit)
}

// A store-wide universe: this tenant owns `tenantTotal` published pages (newest first); the rest of the
// listed ids belong to OTHER tenants (they exist in FGA but not in this tenant's RLS-scoped DB). The
// stubbed ListObjects returns the first `listed` ids of the whole store (OpenFGA's silent cut); the
// stubbed BatchCheck allows exactly `isPublic`.
function stubs(opts: { tenantTotal: number; listed: number; foreignListed?: number; isPublic?: (pageId: string) => boolean }) {
  // distinct instants, newest first — page 0 is the newest
  const mine: PublicListRow[] = Array.from({ length: opts.tenantTotal }, (_, i) => ({
    id: id(i), title: `Page ${i}`, created_at: new Date(Date.UTC(2026, 0, 1) + (opts.tenantTotal - i) * 60_000).toISOString(),
  }))
  const foreign = Array.from({ length: opts.foreignListed ?? 0 }, (_, i) => `page:ffffffff-0000-4000-8000-${String(i).padStart(12, '0')}`)
  const isPublic = opts.isPublic ?? (() => true)
  const calls = { byIds: 0, candidates: 0, windows: [] as number[] }
  const fga = {
    listObjects: async () => ({ objects: [...foreign, ...mine.map((r) => `page:${r.id}`)].slice(0, opts.listed) }),
    batchCheck: async ({ checks }: { checks: { object: string; correlationId: string }[] }) => ({
      result: checks.map((c) => ({ correlationId: c.correlationId, allowed: isPublic(c.object.replace(/^page:/, '')) })),
    }),
  } as unknown as typeof fgaClient
  const load = {
    loadByIds: async (ids: string[], win: PublicPageWindow) => {
      calls.byIds++
      calls.windows.push(win.limit)
      const set = new Set(ids)
      return windowOf(mine.filter((r) => set.has(r.id)), win)
    },
    loadPublishedCandidates: async (win: PublicPageWindow) => {
      calls.candidates++
      calls.windows.push(win.limit)
      return windowOf(mine, win)
    },
  }
  return { fga, load, calls }
}

/** Walk every window to the end, the way a client following the cursor would. */
async function walk(s: ReturnType<typeof stubs>, limit: number) {
  const all: { id: string; title: string }[] = []
  const sizes: number[] = []
  let cursor: string | undefined
  for (let guard = 0; guard < 100; guard++) {
    const page = await listPublicPages(s.fga, s.load, { limit, cursor })
    sizes.push(page.items.length)
    all.push(...page.items)
    if (!page.nextCursor) return { all, sizes }
    cursor = page.nextCursor
  }
  throw new Error('the walk never reached the end — the cursor is not advancing')
}

describe('#545 the public listing does not trust ListObjects past its own ceiling', () => {
  it('a tenant page the store-wide cut dropped is still reachable', async () => {
    // The whole store answers at the floor and OTHER tenants' pages fill most of it — this tenant's
    // pages past the cut simply vanished from its own listing before the fix.
    const s = stubs({ tenantTotal: 300, listed: FLOOR, foreignListed: 900 })
    const { all, sizes } = await walk(s, 50)
    expect(all.length, 'every public page of the tenant is reachable').toBe(300)
    expect(all.some((p) => p.id === id(250)), 'a page beyond the store-wide cut is back').toBe(true)
    expect(new Set(all.map((p) => p.id)).size, 'and none is served twice').toBe(300)
    // #623: no response carries the whole tenant
    expect(Math.max(...sizes), 'every response is bounded by the window').toBeLessThanOrEqual(50)
  })

  it('the fallback confirm is the gate: a published-but-not-public page never enters the listing', async () => {
    // The DB candidate window sees every PUBLISHED tenant page — including ones anonymous may NOT view
    // (visibility narrowed after publish, tuple already revoked). On this branch filterAuthorized is the
    // only thing between them and the anonymous response.
    const s = stubs({ tenantTotal: 50, listed: FLOOR, foreignListed: 1000, isPublic: (p) => p !== id(7) && p !== id(41) })
    const { all } = await walk(s, 100)
    expect(all.length).toBe(48)
    expect(all.some((p) => p.id === id(7)), 'a revoked page stays absent (existence-hiding intact)').toBe(false)
    expect(all.some((p) => p.id === id(41))).toBe(false)
  })

  it('a window the confirm rejects ENTIRELY does not stall the walk', async () => {
    // #623: the cursor must advance past the last candidate EXAMINED, not the last one EMITTED. The
    // difference is invisible while every window emits something — it only bites when a whole window is
    // rejected, and then "last emitted" never moves and the same window is fetched forever. That is not a
    // contrived shape: it is a space whose visibility was narrowed after publishing, sitting at the front
    // of the ordering. (Measured: a first draft of this pin put a single rejected row mid-window, and the
    // broken cursor stayed green — the rejected row was not the last one examined.)
    const hidden = new Set(Array.from({ length: 20 }, (_, i) => id(i)))
    const s = stubs({ tenantTotal: 60, listed: FLOOR, foreignListed: 1000, isPublic: (p) => !hidden.has(p) })
    const { all } = await walk(s, 10) // window = 10 * 2 = 20 candidates — exactly the rejected run
    expect(all.length, 'the 40 visible pages are all reached').toBe(40)
    expect(all.some((p) => p.id === id(20)), 'the first page after the rejected run is served').toBe(true)
    expect(all.some((p) => p.id === id(0)), 'and nothing hidden leaked').toBe(false)
  })

  it('one request does not scan the whole tenant looking for confirmations', async () => {
    // #623: the confirm branch loops over candidate windows, and a loop is how an unbounded read hides
    // once the missing LIMIT is gone. A tenant whose published pages are almost all NON-public is the
    // worst case — a hunt for `limit` confirmations that walks everything. It must come back short with
    // a cursor instead, so the work per request stays bounded and the reader still gets everywhere.
    const visible = new Set([id(990), id(991), id(992)])
    const s = stubs({ tenantTotal: 1000, listed: FLOOR, foreignListed: 1000, isPublic: (p) => visible.has(p) })
    const first = await listPublicPages(s.fga, s.load, { limit: 10 })
    expect(s.calls.candidates, 'a bounded number of windows, not the tenant').toBeLessThanOrEqual(3)
    expect(first.items.length, 'short, because the budget ran out — not because the tenant did').toBeLessThan(10)
    expect(first.nextCursor, 'and it says where to resume').toBeTruthy()
    // …and the walk still reaches the pages that live at the far end
    const { all } = await walk(s, 10)
    expect(all.map((p) => p.id).sort()).toEqual([id(990), id(991), id(992)].sort())
  })

  it('below the floor, ListObjects is authoritative and the DB is only asked about ITS ids', async () => {
    const s = stubs({ tenantTotal: 40, listed: 40 })
    const page = await listPublicPages(s.fga, s.load)
    expect(page.items.length).toBe(40)
    expect(page.nextCursor, 'the whole set fitted in one window').toBeNull()
    expect(s.calls.byIds, 'the original one-call flow').toBe(1)
    expect(s.calls.candidates, 'no candidate sweep below the ceiling').toBe(0)
  })

  it('below the floor the window still bounds the response, and the rest follows the cursor', async () => {
    const s = stubs({ tenantTotal: 40, listed: 40 })
    const first = await listPublicPages(s.fga, s.load, { limit: 15 })
    expect(first.items.length).toBe(15)
    expect(first.nextCursor, 'there is more').toBeTruthy()
    const { all, sizes } = await walk(s, 15)
    expect(all.length).toBe(40)
    expect(Math.max(...sizes)).toBeLessThanOrEqual(15)
  })

  it('a limit past the ceiling is clamped rather than honoured', async () => {
    const s = stubs({ tenantTotal: 40, listed: 40 })
    await listPublicPages(s.fga, s.load, { limit: 100_000 })
    expect(Math.max(...s.calls.windows), 'the caller does not choose an unbounded window').toBeLessThanOrEqual(501)
  })

  it('an empty store answer stays an empty listing (no candidate sweep)', async () => {
    const s = stubs({ tenantTotal: 40, listed: 0 })
    const page = await listPublicPages(s.fga, s.load)
    expect(page.items).toEqual([])
    expect(page.nextCursor).toBeNull()
    expect(s.calls.candidates).toBe(0)
  })
})
