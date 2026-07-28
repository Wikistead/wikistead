// #540: OpenFGA's ListObjects truncates SILENTLY at the server's max results (1000 by default), and the
// dictionary's `capped` flag was computed from DB row counts — downstream of the truncation. A viewer
// with more than 1000 viewable pages got a dictionary that claimed completeness (`capped: false`) while
// titles were simply missing, which reads exactly like existence-hiding in the link autocompletion.
//
// A real 1001-page fixture would poison the shared test tenant (and cost ~1001 FGA writes per run), so
// this drives getTitleDictionary through STUBS shaped like the real clients: listObjects answers with
// exactly the truncation-floor number of ids, batchCheck answers per its own view set. What keeps these
// pins honest is that they were verified against the pre-fix code (all fallback pins red) and that the
// authz behaviour they assert — the confirm is the gate — is the same fail-closed filterAuthorized the
// integration suite (title-dictionary-224) exercises against the real store.
import { describe, it, expect } from 'vitest'
import type { OpenFgaClient } from '@openfga/sdk'
import { getTitleDictionary } from '../routes/pages.js'
import type { TenantDb } from '../db/index.js'

const FLOOR = 1000
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

// A universe of `total` pages, newest first. The stubbed ListObjects returns the first `listed` of them
// (OpenFGA's silent cut); the stubbed BatchCheck allows exactly `viewable`.
function stubs(opts: { total: number; listed: number; viewable: (pageId: string) => boolean }) {
  const all = Array.from({ length: opts.total }, (_, i) => ({ id: id(i), title: `Page ${i}` }))
  const sqlCalls: string[] = []
  const fga = {
    listObjects: async () => ({ objects: all.slice(0, opts.listed).map((r) => `page:${r.id}`) }),
    batchCheck: async ({ checks }: { checks: { object: string; correlationId: string }[] }) => ({
      result: checks.map((c) => ({ correlationId: c.correlationId, allowed: opts.viewable(c.object.replace(/^page:/, '')) })),
    }),
  } as unknown as OpenFgaClient
  const sql = async (strings: TemplateStringsArray, ...vals: unknown[]) => {
    sqlCalls.push(strings.join('?'))
    if (strings.join('').includes('ANY(')) {
      const ids = vals[0] as string[]
      const set = new Set(ids)
      return all.filter((r) => set.has(r.id))
    }
    const limit = vals[vals.length - 1] as number
    return all.slice(0, limit)
  }
  return { fga, db: { sql } as unknown as TenantDb, sqlCalls, all }
}

describe('#540 the dictionary does not trust ListObjects past its own ceiling', () => {
  it('a viewer with more pages than the floor still gets the titles ListObjects cut off', async () => {
    const s = stubs({ total: 1500, listed: FLOOR, viewable: () => true })
    const { entries, capped } = await getTitleDictionary(s.db, s.fga, { subject: 'user:big-admin' })
    // The defect: exactly 1000 entries and capped:false — "complete", with 500 titles missing.
    expect(entries.length, 'titles past the ListObjects cut are present').toBe(1500)
    expect(entries.some((e) => e.id === id(1400)), 'a page the cut dropped is back').toBe(true)
    expect(capped, 'nothing overflowed the dictionary window, so it is honestly uncapped').toBe(false)
  })

  it('the fallback confirm is the gate: an unviewable candidate never enters the dictionary', async () => {
    // The DB candidate window sees every tenant page — including ones this viewer may NOT view. On this
    // branch filterAuthorized is the only thing between them and the response.
    const s = stubs({ total: 1200, listed: FLOOR, viewable: (p) => p !== id(3) && p !== id(1100) })
    const { entries } = await getTitleDictionary(s.db, s.fga, { subject: 'user:member' })
    expect(entries.length).toBe(1198)
    expect(entries.some((e) => e.id === id(3)), 'a denied page inside the old window stays out').toBe(false)
    expect(entries.some((e) => e.id === id(1100)), 'a denied page beyond the old window stays out').toBe(false)
  })

  it('overflow past the dictionary window says so: capped is computed from candidates, upstream of nothing', async () => {
    const s = stubs({ total: 2600, listed: FLOOR, viewable: () => true })
    const { entries, capped } = await getTitleDictionary(s.db, s.fga, { subject: 'user:big-admin' })
    expect(capped, 'the window overflowed and the response admits it').toBe(true)
    expect(entries.length).toBe(2000)
  })

  it('below the floor, ListObjects is authoritative and the DB is only asked about ITS ids', async () => {
    // The case the fallback must not break: a low-privilege member of a huge tenant. Their few viewable
    // pages are found by name — not by having to be among the tenant's newest.
    const s = stubs({ total: 1500, listed: 7, viewable: () => true })
    const { entries, capped } = await getTitleDictionary(s.db, s.fga, { subject: 'user:small-member' })
    expect(entries.length).toBe(7)
    expect(capped).toBe(false)
    expect(s.sqlCalls.length).toBe(1)
    expect(s.sqlCalls[0], 'the query narrowed to the authoritative id set').toContain('ANY(')
  })
})
