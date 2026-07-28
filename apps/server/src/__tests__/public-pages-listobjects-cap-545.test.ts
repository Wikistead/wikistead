// #545 (same defect as #540): GET /public/pages fed OpenFGA's ListObjects — which truncates SILENTLY at
// the server's max results (1000 by default) and spans the whole shared store — straight into the tenant
// listing. Once every tenant's public pages together passed the ceiling, a tenant's public page listing
// dropped entries non-deterministically (whichever ids the server happened to return first).
//
// A real 1000-public-page fixture would poison the shared store, so this drives listPublicPages through
// STUBS shaped like the real clients (the #540 pin's approach): listObjects answers with exactly the
// truncation-floor number of ids, batchCheck answers per its own public set. The ceiling pins were
// verified red against the pre-fix flow; below the floor the original one-call flow is pinned unchanged.
import { describe, it, expect } from 'vitest'
import { listPublicPages } from '../routes/public.js'
import type { fgaClient } from '../authz.js'

const FLOOR = 1000
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

// A store-wide universe: this tenant owns `tenantTotal` published pages (newest first); the rest of the
// listed ids belong to OTHER tenants (they exist in FGA but not in this tenant's RLS-scoped DB). The
// stubbed ListObjects returns the first `listed` ids of the whole store (OpenFGA's silent cut); the
// stubbed BatchCheck allows exactly `isPublic`.
function stubs(opts: { tenantTotal: number; listed: number; foreignListed?: number; isPublic?: (pageId: string) => boolean }) {
  const mine = Array.from({ length: opts.tenantTotal }, (_, i) => ({ id: id(i), title: `Page ${i}` }))
  const foreign = Array.from({ length: opts.foreignListed ?? 0 }, (_, i) => `page:ffffffff-0000-4000-8000-${String(i).padStart(12, '0')}`)
  const isPublic = opts.isPublic ?? (() => true)
  const calls = { byIds: 0, candidates: 0 }
  const fga = {
    listObjects: async () => ({ objects: [...foreign, ...mine.map((r) => `page:${r.id}`)].slice(0, opts.listed) }),
    batchCheck: async ({ checks }: { checks: { object: string; correlationId: string }[] }) => ({
      result: checks.map((c) => ({ correlationId: c.correlationId, allowed: isPublic(c.object.replace(/^page:/, '')) })),
    }),
  } as unknown as typeof fgaClient
  const load = {
    loadByIds: async (ids: string[]) => {
      calls.byIds++
      const set = new Set(ids)
      return mine.filter((r) => set.has(r.id))
    },
    loadPublishedCandidates: async () => {
      calls.candidates++
      return mine
    },
  }
  return { fga, load, calls }
}

describe('#545 the public listing does not trust ListObjects past its own ceiling', () => {
  it('a tenant page the store-wide cut dropped is still listed', async () => {
    // The whole store answers at the floor and OTHER tenants' pages fill most of it — this tenant's
    // pages past the cut simply vanished from its own listing before the fix.
    const s = stubs({ tenantTotal: 300, listed: FLOOR, foreignListed: 900 })
    const pages = await listPublicPages(s.fga, s.load)
    expect(pages.length, 'every public page of the tenant is listed').toBe(300)
    expect(pages.some((p) => p.id === id(250)), 'a page beyond the store-wide cut is back').toBe(true)
  })

  it('the fallback confirm is the gate: a published-but-not-public page never enters the listing', async () => {
    // The DB candidate window sees every PUBLISHED tenant page — including ones anonymous may NOT view
    // (visibility narrowed after publish, tuple already revoked). On this branch filterAuthorized is the
    // only thing between them and the anonymous response.
    const s = stubs({ tenantTotal: 50, listed: FLOOR, foreignListed: 1000, isPublic: (p) => p !== id(7) && p !== id(41) })
    const pages = await listPublicPages(s.fga, s.load)
    expect(pages.length).toBe(48)
    expect(pages.some((p) => p.id === id(7)), 'a revoked page stays absent (existence-hiding intact)').toBe(false)
    expect(pages.some((p) => p.id === id(41))).toBe(false)
  })

  it('below the floor, ListObjects is authoritative and the DB is only asked about ITS ids', async () => {
    const s = stubs({ tenantTotal: 40, listed: 40 })
    const pages = await listPublicPages(s.fga, s.load)
    expect(pages.length).toBe(40)
    expect(s.calls.byIds, 'the original one-call flow').toBe(1)
    expect(s.calls.candidates, 'no candidate sweep below the ceiling').toBe(0)
  })

  it('an empty store answer stays an empty listing (no candidate sweep)', async () => {
    const s = stubs({ tenantTotal: 40, listed: 0 })
    const pages = await listPublicPages(s.fga, s.load)
    expect(pages).toEqual([])
    expect(s.calls.candidates).toBe(0)
  })
})
