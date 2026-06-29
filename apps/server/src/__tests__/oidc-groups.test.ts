// #102 / ADR-055: coerceGroups turns an UNTRUSTED id_token groups claim into a safe, bounded
// string[]. Security-relevant (the claim rides the token), so it must never throw and must cap
// size — an IdP anomaly cannot block login or blow up the row / FGA writes.
import { describe, it, expect } from 'vitest'
import { coerceGroups } from '../auth/oidc.js'

describe('#102 coerceGroups', () => {
  it('keeps an array of trimmed, de-duped non-empty strings', () => {
    expect(coerceGroups(['Engineering', ' Sales ', 'Engineering', ''])).toEqual(['Engineering', 'Sales'])
  })

  it('a non-array (or undefined / null / string) → [] (IdP omitted or sent garbage)', () => {
    for (const bad of [undefined, null, 'not-an-array', 42, {}, true]) expect(coerceGroups(bad)).toEqual([])
  })

  it('drops non-string and blank entries, never throws', () => {
    expect(coerceGroups(['ok', 123, null, '   ', { x: 1 }, 'ok2'])).toEqual(['ok', 'ok2'])
  })

  it('truncates an over-long name to 200 chars', () => {
    const [only] = coerceGroups(['x'.repeat(500)])
    expect(only!.length).toBe(200)
  })

  it('caps the count at 100 groups', () => {
    const many = Array.from({ length: 250 }, (_, i) => `g${i}`)
    expect(coerceGroups(many).length).toBe(100)
  })
})
