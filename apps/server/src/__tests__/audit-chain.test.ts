// Audit-log hash chain (#134 / ADR-070) — the integrity invariant. A well-formed chain
// verifies; tampering a field, deleting an entry, or reordering entries is DETECTED. Pure unit
// tests (no infra), exercising the real hashing (not a mock).
import { describe, it, expect } from 'vitest'
import { linkEntry, verifyAuditChain, computeEntryHash, type AuditEntry, type AuditEntryCore } from '../audit/chain.js'

const core = (seq: number, action: string): AuditEntryCore => ({
  seq, tenantId: 't1', actor: 'user:admin', action, target: `page:${seq}`, at: `2026-06-30T00:0${seq}:00Z`,
})

function buildChain(n: number): AuditEntry[] {
  const out: AuditEntry[] = []
  for (let i = 0; i < n; i++) out.push(linkEntry(out[i - 1] ?? null, core(i, `action.${i}`)))
  return out
}

describe('audit hash chain (#134 / ADR-070 integrity)', () => {
  it('a well-formed chain verifies', () => {
    expect(verifyAuditChain(buildChain(5))).toEqual({ valid: true })
    expect(verifyAuditChain([])).toEqual({ valid: true }) // empty chain is trivially valid
  })

  it('genesis entry links from the empty prev hash', () => {
    const c = buildChain(1)
    expect(c[0].prevHash).toBe('')
    expect(c[0].hash).toBe(computeEntryHash('', { seq: 0, tenantId: 't1', actor: 'user:admin', action: 'action.0', target: 'page:0', at: '2026-06-30T00:00:00Z' }))
  })

  it('DETECTS a tampered field (hash mismatch)', () => {
    const c = buildChain(5)
    c[2] = { ...c[2], actor: 'user:attacker' } // change a field, leave the stored hash
    const v = verifyAuditChain(c)
    expect(v.valid).toBe(false)
    expect(v.brokenAt).toBe(2)
    expect(v.reason).toMatch(/tamper/)
  })

  it('DETECTS a deleted entry (prev_hash discontinuity)', () => {
    const c = buildChain(5)
    c.splice(2, 1) // remove the middle entry
    const v = verifyAuditChain(c)
    expect(v.valid).toBe(false)
    expect(v.brokenAt).toBe(2) // the entry that now follows a gap
  })

  it('DETECTS reordered entries', () => {
    const c = buildChain(5)
    ;[c[1], c[2]] = [c[2], c[1]] // swap two adjacent entries
    expect(verifyAuditChain(c).valid).toBe(false)
  })

  it('DETECTS a re-hashed tamper that is not re-linked into the next entry', () => {
    const c = buildChain(5)
    // attacker tampers entry 2 AND recomputes its own hash, but does not re-link entry 3
    const tampered = { ...c[2], action: 'forged' }
    c[2] = { ...tampered, hash: computeEntryHash(tampered.prevHash, tampered) }
    const v = verifyAuditChain(c)
    expect(v.valid).toBe(false)
    expect(v.brokenAt).toBe(3) // entry 3's prevHash no longer matches entry 2's new hash
  })
})
