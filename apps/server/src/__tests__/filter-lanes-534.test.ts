import { describe, it, expect } from 'vitest'
import { filterAuthorized } from '@wikistead/authz'

// #534: the title dictionary confirms up to 2000 ids, which `filterAuthorized` sends 50 at a time. Those
// chunks ran strictly one after another — #489's pacing — so the confirm alone was up to 40 sequential
// round-trips, the measured ~14s before the editor opens on a large space. Callers whose result is an
// ENHANCEMENT rather than a gate may now take a few lanes. These pin the pacing itself (how many requests
// are in flight), because a wall-clock assertion would be a flake and a comment would be a wish.
function fakeFga(delayMs = 0) {
  let inFlight = 0
  const stats = { batches: 0, maxInFlight: 0 }
  const fga = {
    async batchCheck({ checks }: { checks: { object: string; correlationId: string }[] }) {
      stats.batches += 1
      inFlight += 1
      stats.maxInFlight = Math.max(stats.maxInFlight, inFlight)
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs))
      inFlight -= 1
      return { result: checks.map((c) => ({ correlationId: c.correlationId, allowed: true })) }
    },
  } as unknown as Parameters<typeof filterAuthorized>[0]
  return { fga, stats }
}
const ids = (n: number) => Array.from({ length: n }, (_, i) => `p${i}`)

describe('#534 filterAuthorized batch pacing', () => {
  it('is strictly sequential by default — #489 pacing is the unchanged behaviour', async () => {
    const { fga, stats } = fakeFga(1)
    await filterAuthorized(fga, 'user:u', 'view', ids(200))
    expect(stats.batches, '200 ids = 4 batches of 50').toBe(4)
    expect(stats.maxInFlight, 'one request in flight at a time').toBe(1)
  })

  it('an opted-in caller overlaps a bounded number of batches', async () => {
    const { fga, stats } = fakeFga(1)
    await filterAuthorized(fga, 'user:u', 'view', ids(2000), undefined, 'page', 4)
    expect(stats.batches, 'the same 40 batches — this is pacing, not fewer checks').toBe(40)
    expect(stats.maxInFlight, 'up to 4 at once').toBeGreaterThan(1)
    expect(stats.maxInFlight, 'and never more than asked for').toBeLessThanOrEqual(4)
  })

  it('the fan-out is CLAMPED — a caller cannot ask for all-at-once', async () => {
    const { fga, stats } = fakeFga(1)
    await filterAuthorized(fga, 'user:u', 'view', ids(2000), undefined, 'page', 1000)
    expect(stats.maxInFlight, '#489 was never "one at a time", it was "not all at once"').toBeLessThanOrEqual(8)
  })

  it('lanes do not change the ANSWER — every id still resolves through the same verdicts', async () => {
    const { fga } = fakeFga()
    const seq = await filterAuthorized(fga, 'user:u', 'view', ids(120))
    const par = await filterAuthorized(fga, 'user:u', 'view', ids(120), undefined, 'page', 4)
    expect([...par].sort()).toEqual([...seq].sort())
  })
})
