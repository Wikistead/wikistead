// ADR-253 §3.4 & §6: the decision table, exhaustively — no IO, no OpenFGA, no database. Each case
// name below is the table's own row, so a reader can hold the ADR beside this file and match them.
import { describe, it, expect } from 'vitest'
import { decideStoreBinding, describeRefusal, type Witness, type Candidate } from './store-binding.js'

describe('ADR-253 §3.4 store binding decision table', () => {
  it('absent witness, candidate present → adopt and (the caller) writes the witness', () => {
    const out = decideStoreBinding({
      witness: null,
      candidate: { storeId: 'store-a' },
      candidateIsLive: true,
      witnessStoreIsLive: null,
    })
    expect(out).toEqual({ kind: 'adopt', storeId: 'store-a' })
  })

  it('absent witness, named/found candidate but gone → refuse, naming the id', () => {
    const out = decideStoreBinding({
      witness: null,
      candidate: { storeId: 'store-a' },
      candidateIsLive: false,
      witnessStoreIsLive: null,
    })
    expect(out).toEqual({ kind: 'refuse', reason: { shape: 'named-candidate-gone', storeId: 'store-a' } })
    expect(describeRefusal((out as { reason: import('./store-binding.js').RefusalReason }).reason)).toContain('store-a')
  })

  it('absent witness, none found by name → create (§3.4a decides whether the table itself exists)', () => {
    const out = decideStoreBinding({
      witness: null,
      candidate: 'none',
      candidateIsLive: null,
      witnessStoreIsLive: null,
    })
    expect(out).toEqual({ kind: 'create' })
  })

  it('witness names this store, present → proceed, nothing written', () => {
    const out = decideStoreBinding({
      witness: { storeId: 'store-a' },
      candidate: { storeId: 'store-a' },
      candidateIsLive: true,
      witnessStoreIsLive: true,
    })
    expect(out).toEqual({ kind: 'proceed', storeId: 'store-a' })
  })

  it('witness names this store, gone → refuse: the datastore was lost, naming it', () => {
    const out = decideStoreBinding({
      witness: { storeId: 'store-a' },
      candidate: { storeId: 'store-a' },
      candidateIsLive: false,
      witnessStoreIsLive: false,
    })
    expect(out).toEqual({ kind: 'refuse', reason: { shape: 'witness-store-lost', witnessStoreId: 'store-a' } })
  })

  it('witness names another store, and NOTHING found by name at all → same conclusion as lost (the store never renames)', () => {
    const out = decideStoreBinding({
      witness: { storeId: 'store-a' },
      candidate: 'none',
      candidateIsLive: null,
      witnessStoreIsLive: null,
    })
    expect(out).toEqual({ kind: 'refuse', reason: { shape: 'witness-store-lost', witnessStoreId: 'store-a' } })
  })

  it('witness names store A, this boot would use a DIFFERENT live store B → refuse, naming both', () => {
    const out = decideStoreBinding({
      witness: { storeId: 'store-a' },
      candidate: { storeId: 'store-b' },
      candidateIsLive: true,
      witnessStoreIsLive: null, // never checked — the mismatch alone is disqualifying
    })
    expect(out).toEqual({
      kind: 'refuse',
      reason: { shape: 'witness-mismatch', witnessStoreId: 'store-a', candidateStoreId: 'store-b' },
    })
    const msg = describeRefusal((out as { reason: import('./store-binding.js').RefusalReason }).reason)
    expect(msg).toContain('store-a')
    expect(msg).toContain('store-b')
  })

  it('witness names store A, this boot would use a DIFFERENT gone store B, and A is ALSO gone → refuse, both facts named', () => {
    const out = decideStoreBinding({
      witness: { storeId: 'store-a' },
      candidate: { storeId: 'store-b' },
      candidateIsLive: false,
      witnessStoreIsLive: false,
    })
    expect(out).toEqual({
      kind: 'refuse',
      reason: { shape: 'witness-mismatch-both-gone', witnessStoreId: 'store-a', candidateStoreId: 'store-b' },
    })
    const msg = describeRefusal((out as { reason: import('./store-binding.js').RefusalReason }).reason)
    expect(msg).toContain('store-a')
    expect(msg).toContain('store-b')
    expect(msg).toMatch(/absent/i)
  })

  it('mismatch, candidate gone, witness store liveness unknown or alive → still a refusal (never silently proceeds)', () => {
    for (const witnessStoreIsLive of [null, true] as const) {
      const out = decideStoreBinding({
        witness: { storeId: 'store-a' },
        candidate: { storeId: 'store-b' },
        candidateIsLive: false,
        witnessStoreIsLive,
      })
      expect(out.kind, `witnessStoreIsLive=${witnessStoreIsLive}`).toBe('refuse')
    }
  })

  it('never adopts or proceeds on anything but a live candidate that the witness does not contradict', () => {
    // Every combination that reaches 'adopt' or 'proceed' must have candidateIsLive === true and
    // the candidate id must be the one returned.
    const witnesses: Witness[] = [null, { storeId: 'store-a' }]
    const candidates: Candidate[] = ['none', { storeId: 'store-a' }, { storeId: 'store-b' }]
    for (const witness of witnesses) {
      for (const candidate of candidates) {
        for (const candidateIsLive of [null, true, false] as const) {
          for (const witnessStoreIsLive of [null, true, false] as const) {
            if (candidate === 'none' && candidateIsLive !== null) continue // not a real combination
            const out = decideStoreBinding({ witness, candidate, candidateIsLive, witnessStoreIsLive })
            if (out.kind === 'adopt' || out.kind === 'proceed') {
              expect(candidateIsLive, JSON.stringify({ witness, candidate })).toBe(true)
              expect(candidate === 'none' ? undefined : candidate.storeId).toBe(out.storeId)
            }
          }
        }
      }
    }
  })
})
