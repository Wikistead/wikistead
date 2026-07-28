// #541 (user ruling: don't wait for the whole space's confirm before painting) — the partial
// first paint. Pinned properties:
//   1. firstN confirms ONLY the first N ids (one small batch — the count-proportional cost is gone
//      from the first paint) and never touches the badge reads;
//   2. every returned id went through FGA — a deny inside the window is DROPPED, never backfilled
//      (the partial answer is a strict subset, fail-closed);
//   3. "first N" is DISPLAY (DFS) order — children follow their parent, not raw insert order;
//   4. the partial result never WRITES the confirm cache (a later full call still confirms all);
//   5. a WARM full cache short-circuits the partial ask to the full answer (cheaper than any subset).
import { describe, it, expect } from 'vitest'
import type { OpenFgaClient } from '@openfga/sdk'
import { listPages } from '../routes/pages.js'
import type { TenantDb } from '../db/index.js'

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
let seq = 0

function stubs(rows: { id: string; parent: string | null; pos: number }[], allow: (pageId: string) => boolean) {
  const tenantId = `t-541fp-${++seq}-${Math.random().toString(36).slice(2, 8)}`
  const fullRows = rows.map((r, i) => ({
    id: r.id, tenant_id: tenantId, space_id: 'sp1', parent_id: r.parent, title: `P${i}`, position: r.pos,
    created_at: new Date(2026, 0, 1, 0, 0, i), updated_at: new Date(), has_unpublished_changes: false, published: true,
    task_done: null, task_total: null,
  }))
  const checkedBatches: string[][] = []
  let reads = 0
  const fga = {
    batchCheck: async ({ checks }: { checks: { object: string; correlationId: string }[] }) => {
      checkedBatches.push(checks.map((c) => c.object.replace(/^page:/, '')))
      return { result: checks.map((c) => ({ correlationId: c.correlationId, allowed: allow(c.object.replace(/^page:/, '')) })) }
    },
    read: async () => { reads++; return { tuples: [] } },
  } as unknown as OpenFgaClient
  const db = { sql: async () => fullRows } as unknown as TenantDb
  return { fga, db, checkedBatches, checkedIds: () => checkedBatches.flat(), readCount: () => reads }
}

const flat = (n: number) => Array.from({ length: n }, (_, i) => ({ id: id(i), parent: null, pos: i }))

describe('#541: the partial first paint (firstN)', () => {
  it('confirms only the first N and skips the badge reads entirely', async () => {
    const s = stubs(flat(120), () => true)
    const out = await listPages(s.db, s.fga, { spaceId: 'sp1', subject: 'user:u', firstN: 10 })
    expect(out).toHaveLength(10)
    expect(s.checkedIds(), 'exactly the window was asked, not the space').toHaveLength(10)
    expect(s.readCount(), 'badges are deferred to the full response').toBe(0)
    expect(out.every((p) => p.private === false && p.frozen === null)).toBe(true)
  })

  it('a deny inside the window is dropped, never backfilled (fail-closed subset)', async () => {
    const s = stubs(flat(50), (p) => p !== id(3))
    const out = await listPages(s.db, s.fga, { spaceId: 'sp1', subject: 'user:u', firstN: 5 })
    expect(out.map((p) => p.id)).toEqual([id(0), id(1), id(2), id(4)]) // 4 rows — no 6th id sneaks in
    expect(s.checkedIds()).toHaveLength(5)
  })

  it('"first N" is DISPLAY (DFS) order — a child under the first root outranks the second root', async () => {
    const rows = [
      { id: id(0), parent: null, pos: 0 },
      { id: id(1), parent: id(0), pos: 0 }, // child of the first root
      { id: id(2), parent: null, pos: 1 },
      { id: id(3), parent: id(2), pos: 0 },
    ]
    const s = stubs(rows, () => true)
    const out = await listPages(s.db, s.fga, { spaceId: 'sp1', subject: 'user:u', firstN: 2 })
    expect(s.checkedIds(), 'root, then ITS child — not the flat insert order').toEqual([id(0), id(1)])
    expect(out.map((p) => p.id)).toEqual([id(0), id(1)])
  })

  it('never writes the confirm cache: the full call after a partial still confirms everything', async () => {
    const s = stubs(flat(30), () => true)
    await listPages(s.db, s.fga, { spaceId: 'sp1', subject: 'user:u', firstN: 5 })
    await listPages(s.db, s.fga, { spaceId: 'sp1', subject: 'user:u' })
    expect(s.checkedBatches[0], 'partial window').toHaveLength(5)
    expect(s.checkedIds().length, 'the full call confirmed all 30 — the partial never posed as the set').toBe(35)
  })

  it('a WARM full cache short-circuits the partial ask to the full answer, with no new checks', async () => {
    const s = stubs(flat(30), () => true)
    await listPages(s.db, s.fga, { spaceId: 'sp1', subject: 'user:u' }) // primes the cache
    const before = s.checkedIds().length
    const out = await listPages(s.db, s.fga, { spaceId: 'sp1', subject: 'user:u', firstN: 5 })
    expect(out, 'the whole tree — cheaper than any subset when already confirmed').toHaveLength(30)
    expect(s.checkedIds().length, 'no new checks').toBe(before)
  })
})
