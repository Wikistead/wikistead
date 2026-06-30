// Signed search cursor (#103 / ADR-068) — the side-channel anti-tests the cursor must satisfy.
// Pure (HMAC only): a valid cursor round-trips its offset; any tamper or cross-scope reuse decodes
// to 0 (safe restart, never an error oracle); the cursor body is not a readable offset.
import { describe, it, expect, beforeAll } from 'vitest'
import { encodeCursor, decodeCursor, type CursorScope } from '../search/cursor.js'

beforeAll(() => { process.env.SEARCH_CURSOR_SECRET = 'test-cursor-secret' })

const scope = (over: Partial<CursorScope> = {}): CursorScope => ({
  tenantId: 'tenant_dev', principal: 'user:alice', q: 'design docs', spaceId: 's1', ...over,
})

describe('search cursor (#103 / ADR-068)', () => {
  it('round-trips the offset for the same scope', () => {
    const c = encodeCursor(60, scope())
    expect(decodeCursor(c, scope())).toBe(60)
  })

  it('is opaque: the body is not the plaintext offset (no scan-depth leak)', () => {
    const c = encodeCursor(200, scope())
    expect(c).not.toContain('200') // offset is base64url + HMAC, not a readable number
  })

  it('a tampered body (re-pointed offset) is rejected → restart at 0', () => {
    const c = encodeCursor(60, scope())
    const forged = `${Buffer.from('9999').toString('base64url')}.${c.slice(c.indexOf('.') + 1)}`
    expect(decodeCursor(forged, scope())).toBe(0) // MAC was over offset 60, not 9999
  })

  it('a tampered signature is rejected → 0', () => {
    const c = encodeCursor(60, scope())
    expect(decodeCursor(`${c.slice(0, c.indexOf('.'))}.deadbeef`, scope())).toBe(0)
  })

  it('a cursor minted for query A is invalid on query B (query-bound)', () => {
    const c = encodeCursor(60, scope({ q: 'query A' }))
    expect(decodeCursor(c, scope({ q: 'query B' }))).toBe(0)
    expect(decodeCursor(c, scope({ q: 'query A', spaceId: 'other' }))).toBe(0) // spaceId is part of scope
  })

  it("another principal's / tenant's cursor is invalid (principal+tenant-bound)", () => {
    const c = encodeCursor(60, scope({ principal: 'user:alice' }))
    expect(decodeCursor(c, scope({ principal: 'user:mallory' }))).toBe(0)
    expect(decodeCursor(encodeCursor(60, scope({ tenantId: 'tenant_a' })), scope({ tenantId: 'tenant_b' }))).toBe(0)
  })

  it('absent / malformed / non-positive cursors decode to 0 (no throw)', () => {
    expect(decodeCursor(undefined, scope())).toBe(0)
    expect(decodeCursor('', scope())).toBe(0)
    expect(decodeCursor('garbage', scope())).toBe(0) // no dot
    expect(decodeCursor('.sigonly', scope())).toBe(0)
    expect(decodeCursor('body.', scope())).toBe(0)
    expect(decodeCursor(encodeCursor(0, scope()), scope())).toBe(0) // 0/negative never a live cursor
  })
})
