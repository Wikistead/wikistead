// #547 / ADR-196 §7: the tenant-aware driver resolution order — resolver → registered global →
// caller fallback — and the null-decline fallthrough an unentitled tenant rides.
import { describe, it, expect, beforeEach } from 'vitest'
import {
  registerEmailDriver, registerEmailDriverResolver, resolveTenantEmailDriver,
  type EmailDriver,
} from '@wikistead/hooks'

const mk = (tag: string): EmailDriver & { tag: string } => ({ tag, send: async () => {} })

// module-global state: reset both slots before each case
beforeEach(() => {
  registerEmailDriverResolver(() => null)
  // @ts-expect-error deliberate: null resets the boot-time slot for the test
  registerEmailDriver(null)
})

describe('#547 resolveTenantEmailDriver', () => {
  it('nothing registered → the caller fallback', () => {
    const fb = mk('fallback')
    expect(resolveTenantEmailDriver({ tenantId: 't1', plan: 'free' }, fb)).toBe(fb)
  })

  it('a registered global beats the fallback (the degenerate tenant-independent form)', () => {
    const g = mk('global')
    registerEmailDriver(g)
    expect(resolveTenantEmailDriver({ tenantId: 't1', plan: 'free' }, mk('fallback'))).toBe(g)
  })

  it('the resolver wins when it answers, per tenant', () => {
    const managed = mk('managed')
    registerEmailDriver(mk('global'))
    registerEmailDriverResolver((ctx) => (ctx.tenantId === 'cloud-tenant' ? managed : null))
    expect(resolveTenantEmailDriver({ tenantId: 'cloud-tenant', plan: 'team' }, mk('fb'))).toBe(managed)
  })

  it('a resolver DECLINE (null) falls through — the unentitled tenant rides the default, never a 500', () => {
    const g = mk('global')
    registerEmailDriver(g)
    registerEmailDriverResolver(() => null)
    expect(resolveTenantEmailDriver({ tenantId: 'ce-tenant', plan: 'free' }, mk('fb'))).toBe(g)
  })
})
