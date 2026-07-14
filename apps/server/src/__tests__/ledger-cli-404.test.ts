// #404: the operator-ledger CLI's formatting/verdict surface. The chain read itself is covered by the
// #179 ledger tests; this pins the CLI contract: human summary + verdict line, JSONL export shape, and
// the exit-relevant ok flag for an intact vs broken chain. Pure (no DB — feeds crafted chain results).
import { describe, it, expect } from 'vitest'
import { formatLedger } from '../audit/operator-ledger-cli.js'
import { linkEntry, verifyAuditChain, type AuditEntry } from '../audit/chain.js'

function chain(n: number): AuditEntry[] {
  const out: AuditEntry[] = []
  for (let i = 1; i <= n; i++) {
    out.push(linkEntry(out.at(-1) ?? null, {
      seq: i, tenantId: '@operator', actor: 'operator:root', action: `act.${i}`, target: `tenant:t${i}`, at: `2026-07-14T00:00:0${i}Z`,
    }))
  }
  return out
}

describe('formatLedger (#404)', () => {
  it('human mode: per-entry lines + VERIFIED verdict, ok=true on an intact chain', () => {
    const entries = chain(3)
    const { lines, ok } = formatLedger({ entries, verdict: verifyAuditChain(entries) }, false)
    expect(ok).toBe(true)
    expect(lines[0]).toContain('3 entries')
    expect(lines[1]).toContain('operator:root')
    expect(lines.at(-1)).toContain('VERIFIED')
  })

  it('a TAMPERED chain reports BROKEN with the index and reason, ok=false', () => {
    const entries = chain(3)
    entries[1] = { ...entries[1]!, action: 'act.FORGED' } // content no longer matches its hash
    const { lines, ok } = formatLedger({ entries, verdict: verifyAuditChain(entries) }, false)
    expect(ok).toBe(false)
    expect(lines.at(-1)).toContain('BROKEN')
    expect(lines.at(-1)).toContain('1')
  })

  it('json mode: one JSONL line per entry + a final verdict line', () => {
    const entries = chain(2)
    const { lines, ok } = formatLedger({ entries, verdict: verifyAuditChain(entries) }, true)
    expect(ok).toBe(true)
    expect(lines).toHaveLength(3)
    expect(JSON.parse(lines[0]!).seq).toBe(1)
    expect(JSON.parse(lines.at(-1)!).verdict.valid).toBe(true)
  })

  it('an empty ledger verifies (0 entries, VERIFIED)', () => {
    const { lines, ok } = formatLedger({ entries: [], verdict: verifyAuditChain([]) }, false)
    expect(ok).toBe(true)
    expect(lines[0]).toContain('0 entries')
  })
})
