// deleteObjectTuples (packages/authz tuples.ts) — the "no ghost authorization" sweep run when a space
// or page is deleted: read every tuple on the object and delete it, so no FGA grant (incl. share_link)
// outlives the resource. A bug here = lingering authorization to a deleted resource. Integration-only
// today; pin the pure sweep logic with a fake FGA: all complete keys deleted, malformed keys skipped,
// and an empty object performs NO write (no spurious call). Distinct inputs so a regression is caught.
import { describe, it, expect } from 'vitest'
import type { OpenFgaClient } from '@openfga/sdk'
import { deleteObjectTuples } from '@wikistead/authz'

function fakeFga(readTuples: Array<{ key?: { user?: string; relation?: string; object?: string } }>) {
  const writes: Array<{ deletes?: unknown[] }> = []
  const client = {
    read: async (req: { object: string }) => {
      expect(req.object).toBe('space:s1') // reads scoped to the target object
      return { tuples: readTuples }
    },
    write: async (req: { deletes?: unknown[] }) => { writes.push(req) },
  } as unknown as OpenFgaClient
  return { client, writes }
}

describe('deleteObjectTuples — ghost-authorization sweep on delete', () => {
  it('deletes EVERY complete tuple on the object (members + share_link, one sweep)', async () => {
    const { client, writes } = fakeFga([
      { key: { user: 'user:a', relation: 'viewer', object: 'space:s1' } },
      { key: { user: 'share_link:tok', relation: 'viewer', object: 'space:s1' } },
    ])
    await deleteObjectTuples(client, 'space:s1')
    expect(writes).toHaveLength(1)
    expect(writes[0]!.deletes).toEqual([
      { user: 'user:a', relation: 'viewer', object: 'space:s1' },
      { user: 'share_link:tok', relation: 'viewer', object: 'space:s1' },
    ])
  })

  it('SKIPS malformed tuples (missing user/relation/object), deleting only complete ones', async () => {
    const { client, writes } = fakeFga([
      { key: { user: 'user:a', relation: 'viewer', object: 'space:s1' } },
      { key: { user: 'user:b', relation: '', object: 'space:s1' } }, // malformed → skipped
      { key: { relation: 'viewer', object: 'space:s1' } },            // no user → skipped
      {},                                                             // no key → skipped
    ])
    await deleteObjectTuples(client, 'space:s1')
    expect(writes[0]!.deletes).toEqual([{ user: 'user:a', relation: 'viewer', object: 'space:s1' }])
  })

  it('performs NO write when the object has no tuples (no spurious empty delete)', async () => {
    const { client, writes } = fakeFga([])
    await deleteObjectTuples(client, 'space:s1')
    expect(writes).toHaveLength(0)
  })
})
