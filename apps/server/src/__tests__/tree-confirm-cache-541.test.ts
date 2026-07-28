// #541: the page tree's view-confirm cache (the #534 dict cache's sibling). Pinned properties:
//   1. within TTL, the SAME viewer+space asks the checker NOTHING (the storm halves);
//   2. a page the entry never saw (created since) is confirmed as a DELTA — never assumed;
//   3. a cached deny stays deny (fail-closed) and a different viewer shares nothing;
//   4. the tenant invalidation drops the entry (the same trusted signal as #534);
//   5. a generation moving mid-compute refuses the write (the #534 race rule).
import { describe, it, expect } from 'vitest'
import type { OpenFgaClient } from '@openfga/sdk'
import { listPages } from '../routes/pages.js'
import { invalidateTreeConfirmCache, setTreeConfirm, getTreeConfirm } from '../tree-confirm-cache.js'
import { titleDictGeneration, invalidateTitleDictCache } from '../title-dict-cache.js'
import type { TenantDb } from '../db/index.js'

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
let tenantSeq = 0

function stubs(pageCount: number, allow: (pageId: string) => boolean) {
  const tenantId = `t-541-${++tenantSeq}-${Math.random().toString(36).slice(2, 8)}`
  const rows = Array.from({ length: pageCount }, (_, i) => ({
    id: id(i), tenant_id: tenantId, space_id: 'sp1', parent_id: null, title: `P${i}`, position: i,
    created_at: new Date(), updated_at: new Date(), has_unpublished_changes: false, published: true,
    task_done: null, task_total: null,
  }))
  let batches = 0
  const fga = {
    batchCheck: async ({ checks }: { checks: { object: string; correlationId: string }[] }) => {
      batches++
      return { result: checks.map((c) => ({ correlationId: c.correlationId, allowed: allow(c.object.replace(/^page:/, '')) })) }
    },
    read: async () => ({ tuples: [] }), // badges: no private/frozen markers
  } as unknown as OpenFgaClient
  const db = { sql: async () => rows } as unknown as TenantDb
  return { tenantId, rows, fga, db, batchCount: () => batches }
}

describe('#541: the tree confirm cache', () => {
  it('a second open within the TTL asks the checker nothing', async () => {
    const s = stubs(120, () => true)
    const a = await listPages(s.db, s.fga, { spaceId: 'sp1', subject: 'user:u' })
    expect(a.length).toBe(120)
    const after = s.batchCount()
    const b = await listPages(s.db, s.fga, { spaceId: 'sp1', subject: 'user:u' })
    expect(b.length).toBe(120)
    expect(s.batchCount(), 'no new batches on the cached open').toBe(after)
  })

  it('a page the entry never saw is confirmed as a delta — never assumed', async () => {
    // review hole 1 closed: the delta contains BOTH an allowed and a DENIED new page, so "never
    // assumed" is pinned on the deny side too (an implementation that admits unknown ids passes the
    // allowed assertion alone).
    const s = stubs(10, (p) => p !== id(9) && p !== id(11))
    await listPages(s.db, s.fga, { spaceId: 'sp1', subject: 'user:u' })
    s.rows.push({ ...s.rows[0]!, id: id(10) }, { ...s.rows[0]!, id: id(11) })
    const before = s.batchCount()
    const b = await listPages(s.db, s.fga, { spaceId: 'sp1', subject: 'user:u' })
    expect(s.batchCount(), 'the delta was checked').toBe(before + 1)
    expect(b.some((p) => p.id === id(10)), 'an allowed new page appears').toBe(true)
    expect(b.some((p) => p.id === id(11)), 'a DENIED new page stays out — never assumed').toBe(false)
    expect(b.some((p) => p.id === id(9)), 'a cached deny stays hidden').toBe(false)
  })

  it('a GUEST (share_link) never rides the cache — revoke stays instant by construction', async () => {
    // Design-review finding: share-link revoke does not travel the reindex outbox, so no invalidation
    // reaches this cache; a cached guest tree would outlive its revoke for the TTL. The fix is a
    // BYPASS, pinned here: two consecutive guest lists both go to FGA, and a verdict flipped between
    // them (the revoke) is honoured immediately.
    let revoked = false
    const s = stubs(12, () => !revoked)
    const guest = { spaceId: 'sp1', subject: 'share_link:g1' }
    const a = await listPages(s.db, s.fga, guest)
    expect(a.length).toBe(12)
    const after = s.batchCount()
    revoked = true // the tuple is gone — the next ask must see it NOW, not at TTL
    const b = await listPages(s.db, s.fga, guest)
    expect(s.batchCount(), 'the guest went to FGA again (no cache)').toBeGreaterThan(after)
    expect(b.length, 'the revoke is instant').toBe(0)
  })

  it('a different viewer shares nothing', async () => {
    const s = stubs(20, () => true)
    await listPages(s.db, s.fga, { spaceId: 'sp1', subject: 'user:u1' })
    const before = s.batchCount()
    await listPages(s.db, s.fga, { spaceId: 'sp1', subject: 'user:u2' })
    expect(s.batchCount(), 'the other viewer recomputed').toBeGreaterThan(before)
  })

  it('the tenant invalidation drops the entry', async () => {
    const s = stubs(20, () => true)
    await listPages(s.db, s.fga, { spaceId: 'sp1', subject: 'user:u' })
    invalidateTreeConfirmCache(s.tenantId)
    const before = s.batchCount()
    await listPages(s.db, s.fga, { spaceId: 'sp1', subject: 'user:u' })
    expect(s.batchCount(), 'recomputed after the signal').toBeGreaterThan(before)
  })

  it('a generation moving mid-compute refuses the write (the #534 race rule)', () => {
    const t = `t-gen-${Math.random().toString(36).slice(2, 8)}`
    const genBefore = titleDictGeneration(t)
    invalidateTitleDictCache(t) // the world changed after the compute started
    setTreeConfirm(t, 'user:u', 'sp1', new Map([[id(1), true]]), Date.now(), genBefore)
    expect(getTreeConfirm(t, 'user:u', 'sp1'), 'the stale write was refused').toBeUndefined()
  })
})
