// #541the dictionary confirm is TIME-BUDGETED. The socket-close abort does not fire behind the
// vite proxy (the backend's socket belongs to the proxy and stays open), so an abandoned dictionary ran
// its full multi-second confirm THROUGH the next page-open and starved its interactive checks — the
// measured bimodal sidebar. The bound is therefore self-imposed: confirm in slices, stop when the budget
// is spent, return only what was CONFIRMED with `degraded: true`. Partial = strictly under-disclosure:
// an id the budget never reached is absent, never allowed by default — pinned below.
import { describe, it, expect } from 'vitest'
import type { OpenFgaClient } from '@openfga/sdk'
import { getTitleDictionary } from '../routes/pages.js'
import type { TenantDb } from '../db/index.js'

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

function stubs(opts: { total: number; batchDelayMs?: number; allow?: (pageId: string) => boolean }) {
  const all = Array.from({ length: opts.total }, (_, i) => ({ id: id(i), title: `Page ${i}` }))
  const allow = opts.allow ?? (() => true)
  let batches = 0
  const fga = {
    listObjects: async () => ({ objects: all.map((r) => `page:${r.id}`) }),
    batchCheck: async ({ checks }: { checks: { object: string; correlationId: string }[] }) => {
      batches++
      if (opts.batchDelayMs) await new Promise((r) => setTimeout(r, opts.batchDelayMs))
      return { result: checks.map((c) => ({ correlationId: c.correlationId, allowed: allow(c.object.replace(/^page:/, '')) })) }
    },
  } as unknown as OpenFgaClient
  const sql = async (strings: TemplateStringsArray, ...vals: unknown[]) => {
    if (strings.join('').includes('ANY(')) {
      const set = new Set(vals[0] as string[])
      return all.filter((r) => set.has(r.id))
    }
    return all.slice(0, vals[vals.length - 1] as number)
  }
  return { fga, db: { sql } as unknown as TenantDb, batchCount: () => batches }
}

describe('#541: the dictionary confirm stops at its budget and stays fail-closed', () => {
  it('a spent budget returns ONLY confirmed entries, flags degraded, and stops asking', async () => {
    // 600 ids = 3 slices of 200. Each 50-id batch takes 60ms → a slice ≈ 60ms (4 lanes). The budget is
    // checked BETWEEN slices: 50ms admits slice 1 and is spent before slice 2 → 400 ids never
    // confirmed, and they must be ABSENT.
    const s = stubs({ total: 600, batchDelayMs: 60 })
    const r = await getTitleDictionary(s.db, s.fga, { subject: 'user:u', budgetMs: 50 })
    expect(r.degraded, 'the partial answer says so').toBe(true)
    expect(r.entries.length, 'only the confirmed slice made it').toBe(200)
    expect(r.entries.some((e) => e.id === id(450)), 'an unreached id is absent, never allowed by default').toBe(false)
    expect(s.batchCount(), 'the checker stopped being asked').toBeLessThanOrEqual(8)
  })

  it('within budget nothing changes: complete entries, no degraded flag', async () => {
    const s = stubs({ total: 300 })
    const r = await getTitleDictionary(s.db, s.fga, { subject: 'user:u' })
    expect(r.entries.length).toBe(300)
    expect(r.degraded).toBeUndefined()
  })

  it('denied ids stay denied inside a confirmed slice (the budget changes WHEN we stop, never a verdict)', async () => {
    const s = stubs({ total: 300, allow: (p) => p !== id(5) })
    const r = await getTitleDictionary(s.db, s.fga, { subject: 'user:u' })
    expect(r.entries.some((e) => e.id === id(5))).toBe(false)
    expect(r.entries.length).toBe(299)
  })
})
