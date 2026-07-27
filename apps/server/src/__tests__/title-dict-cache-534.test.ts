import { describe, it, expect, beforeEach } from 'vitest'
import {
  getCachedTitleDict, setCachedTitleDict, invalidateTitleDictCache, clearTitleDictCache, titleDictGeneration,
} from '../title-dict-cache.js'

// #534: the title dictionary is cached for a few seconds because confirming it against OpenFGA costs
// ~1.3s on a large space (measured) and the client refetches every 30s. A dictionary is exactly "the
// titles this principal may see", so the dangerous mistake is sharing one between principals — these pin
// the separation, the expiry, and that the tenant-wide invalidation reaches every viewer's entry.
const dict = (...titles: string[]) => ({ entries: titles.map((t, i) => ({ id: `p${i}`, title: t })), capped: false })

describe('#534 title-dictionary cache', () => {
  beforeEach(() => clearTitleDictCache())

  it('never serves one viewer another viewer titles', () => {
    setCachedTitleDict('t1', 'user:alice', dict('Alice private page'))
    expect(getCachedTitleDict('t1', 'user:bob'), 'bob gets nothing from alice entry').toBeUndefined()
    setCachedTitleDict('t1', 'user:bob', dict('Bob page'))
    expect(getCachedTitleDict('t1', 'user:alice')!.entries[0]!.title).toBe('Alice private page')
    expect(getCachedTitleDict('t1', 'user:bob')!.entries[0]!.title).toBe('Bob page')
  })

  it('never crosses a tenant boundary, even for the same subject string', () => {
    // the same sub can be a member of two tenants; the cache lives in one process for all of them
    setCachedTitleDict('t1', 'user:alice', dict('Tenant one page'))
    expect(getCachedTitleDict('t2', 'user:alice')).toBeUndefined()
  })

  it('a guest link is its own principal', () => {
    setCachedTitleDict('t1', 'user:alice', dict('Member page'))
    expect(getCachedTitleDict('t1', 'share_link:abc')).toBeUndefined()
  })

  it('expires on its own', () => {
    const t0 = 1_000_000
    setCachedTitleDict('t1', 'user:alice', dict('X'), t0)
    expect(getCachedTitleDict('t1', 'user:alice', t0 + 1_000), 'inside the window').toBeDefined()
    expect(getCachedTitleDict('t1', 'user:alice', t0 + 60_000), 'past it').toBeUndefined()
  })

  it('the tenant invalidation drops EVERY viewer in that tenant and nobody else', () => {
    setCachedTitleDict('t1', 'user:alice', dict('A'))
    setCachedTitleDict('t1', 'user:bob', dict('B'))
    setCachedTitleDict('t2', 'user:carol', dict('C'))
    invalidateTitleDictCache('t1')
    expect(getCachedTitleDict('t1', 'user:alice'), 'alice dropped').toBeUndefined()
    expect(getCachedTitleDict('t1', 'user:bob'), 'bob dropped too — a revoke is not per-viewer').toBeUndefined()
    expect(getCachedTitleDict('t2', 'user:carol'), 'another tenant is untouched').toBeDefined()
  })

  it('a tenant id that is a prefix of another is not caught by the sweep', () => {
    setCachedTitleDict('t1', 'user:alice', dict('A'))
    setCachedTitleDict('t10', 'user:alice', dict('B'))
    invalidateTitleDictCache('t1')
    expect(getCachedTitleDict('t1', 'user:alice')).toBeUndefined()
    expect(getCachedTitleDict('t10', 'user:alice'), 't10 is a different tenant').toBeDefined()
  })

  // The race the design review caught: computing a dictionary takes ~1.3s, so a revoke can land in the
  // middle of one. Clearing the cache is not enough — the in-flight result, computed against the tuples as
  // they were, would be written AFTER the clear and republish the revoked title for another TTL. Worse,
  // the client refetches on that very invalidation, so it would likely be the one to catch it.
  it('refuses a value computed before an invalidation that landed mid-flight', () => {
    const seen = titleDictGeneration('t1')      // what a request reads before it starts computing
    invalidateTitleDictCache('t1')              // …a revoke lands while it is still computing
    setCachedTitleDict('t1', 'user:alice', dict('Revoked page'), Date.now(), seen)
    expect(getCachedTitleDict('t1', 'user:alice'), 'the stale answer must not outlive the request').toBeUndefined()
  })

  it('…but a value computed entirely after the invalidation IS cached', () => {
    invalidateTitleDictCache('t1')
    const seen = titleDictGeneration('t1')      // read AFTER, so it describes the world post-revoke
    setCachedTitleDict('t1', 'user:alice', dict('Still visible'), Date.now(), seen)
    expect(getCachedTitleDict('t1', 'user:alice')).toBeDefined()
  })

  it('the generation is per tenant — another tenant revoke does not throw away my work', () => {
    const seen = titleDictGeneration('t1')
    invalidateTitleDictCache('t2')
    setCachedTitleDict('t1', 'user:alice', dict('Fine'), Date.now(), seen)
    expect(getCachedTitleDict('t1', 'user:alice')).toBeDefined()
  })

  it('stays bounded — an unbounded map would be a memory leak per viewer', () => {
    for (let i = 0; i < 600; i++) setCachedTitleDict('t1', `user:u${i}`, dict(`P${i}`))
    // the oldest were evicted; the newest are still there
    expect(getCachedTitleDict('t1', 'user:u0')).toBeUndefined()
    expect(getCachedTitleDict('t1', 'user:u599')).toBeDefined()
  })
})
