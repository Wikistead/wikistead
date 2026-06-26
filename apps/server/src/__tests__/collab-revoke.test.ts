import { describe, it, expect } from 'vitest'
import { publishRevoke, revokeChannel } from '../collab-revoke.js'

// #106 / ADR-028: the server forwards a share-link revoke to the collab server over Valkey.
// Pure tests — the FGA tuple delete (authority) and the actual disconnect are exercised
// elsewhere; here we pin the channel + payload contract the collab subscriber relies on.
describe('revokeChannel', () => {
  it('targets the per-document channel for a (tenant, page)', () => {
    expect(revokeChannel('t:tenant_dev:p:demo')).toBe('wks:revoke:t:tenant_dev:p:demo')
  })
})

describe('publishRevoke', () => {
  it('publishes { shareLinkId } on the document channel and returns the subscriber count', async () => {
    const calls: { channel: string; message: string }[] = []
    const valkey = { publish: async (channel: string, message: string) => { calls.push({ channel, message }); return 2 } }
    const n = await publishRevoke(valkey as never, { tenantId: 'tenant_dev', pageId: 'demo', shareLinkId: 'link-1' })
    expect(n).toBe(2)
    expect(calls).toEqual([
      { channel: 'wks:revoke:t:tenant_dev:p:demo', message: JSON.stringify({ shareLinkId: 'link-1' }) },
    ])
  })

  it('swallows a Valkey error and returns 0 (revocation already succeeded at the FGA layer)', async () => {
    const valkey = { publish: async () => { throw new Error('valkey down') } }
    await expect(
      publishRevoke(valkey as never, { tenantId: 't', pageId: 'p', shareLinkId: 'l' }),
    ).resolves.toBe(0)
  })
})
