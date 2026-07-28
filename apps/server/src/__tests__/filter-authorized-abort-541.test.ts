// #541 a big confirm whose requester has gone away must STOP between batch waves. An abandoned
// title-dictionary fan-out kept flooding the checker for seconds after its tab navigated, and the NEXT
// page-open's interactive checks queued behind it — measured on dev as the sidebar's bimodal 2.7s/7.8s.
// The abort THROWS: no id is ever allowed or denied by it (the response is dead), so authz semantics
// are untouched — pinned here alongside the stop itself.
import { describe, it, expect } from 'vitest'
import type { OpenFgaClient } from '@openfga/sdk'
import { filterAuthorized } from '@wikistead/authz'

function fakeFga(allow: (id: string) => boolean, onBatch?: () => void) {
  const batchChunks: number[] = []
  const client = {
    batchCheck: async (body: { checks: { object: string; correlationId?: string }[] }) => {
      batchChunks.push(body.checks.length)
      onBatch?.()
      return {
        result: body.checks.map((c) => ({
          allowed: allow(c.object.replace(/^page:/, '')),
          request: c,
          correlationId: c.correlationId!,
        })),
      }
    },
  } as unknown as OpenFgaClient
  return { client, batchChunks }
}

const ids = (n: number) => Array.from({ length: n }, (_, i) => `id-${i}`)

describe('#541: filterAuthorized stops between waves when the requester is gone', () => {
  it('an abort signalled after the first wave prevents every later wave, and THROWS', async () => {
    const abort = new AbortController()
    // 200 ids @ 50/chunk, 1 lane → 4 waves. Abort fires during the first batch, so wave 2 must not start.
    const { client, batchChunks } = fakeFga(() => true, () => abort.abort())
    await expect(
      filterAuthorized(client, 'user:u', 'view', ids(200), undefined, 'page', 1, abort.signal),
    ).rejects.toThrow(/aborted/)
    expect(batchChunks.length, 'only the in-flight wave ran; the rest never started').toBe(1)
  })

  it('an abort never fabricates a verdict: it throws instead of returning a partial set', async () => {
    const abort = new AbortController()
    const { client } = fakeFga((id) => id !== 'id-3', () => abort.abort())
    // If this resolved, a partial Set could be mistaken for "everything else was denied" — the exact
    // fail-closed shape a caller would then serve. Throwing is the only honest answer.
    await expect(
      filterAuthorized(client, 'user:u', 'view', ids(120), undefined, 'page', 1, abort.signal),
    ).rejects.toThrow()
  })

  it('no signal (every existing caller) is byte-identical to before', async () => {
    const { client, batchChunks } = fakeFga((id) => id !== 'id-7')
    const out = await filterAuthorized(client, 'user:u', 'view', ids(120), undefined, 'page', 1)
    expect(out.size).toBe(119)
    expect(out.has('id-7')).toBe(false)
    expect(batchChunks.length).toBe(3)
  })

  it('an already-aborted signal stops before ANY wave', async () => {
    const abort = new AbortController()
    abort.abort()
    const { client, batchChunks } = fakeFga(() => true)
    await expect(
      filterAuthorized(client, 'user:u', 'view', ids(100), undefined, 'page', 1, abort.signal),
    ).rejects.toThrow(/aborted/)
    expect(batchChunks.length).toBe(0)
  })
})
