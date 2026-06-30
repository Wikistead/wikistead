import { describe, it, expect } from 'vitest'
import { decideAllowance, crossedThresholds } from '@wikistead/entitlements'

// #128 / ADR-082: the soft-cap is NON-DESTRUCTIVE — it blocks NEW consumption at/over the cap but
// never touches existing usage; uncapped (Infinity) is inert (self-host UNLIMITED). Tested with
// distinct values (under / exactly-at / over / uncapped) so "allowed" is a real boundary, not a constant.
describe('decideAllowance (#128 soft-cap)', () => {
  it('allows while under the cap, with correct remaining headroom', () => {
    expect(decideAllowance(30, 100)).toEqual({ allowed: true, usage: 30, cap: 100, remaining: 70 })
  })
  it('BLOCKS new consumption exactly AT the cap (usage >= cap), remaining 0', () => {
    expect(decideAllowance(100, 100)).toEqual({ allowed: false, usage: 100, cap: 100, remaining: 0 })
  })
  it('BLOCKS over the cap and never reports negative remaining', () => {
    expect(decideAllowance(140, 100)).toEqual({ allowed: false, usage: 140, cap: 100, remaining: 0 })
  })
  it('is INERT when uncapped (Infinity → self-host UNLIMITED): always allowed, Infinity remaining', () => {
    expect(decideAllowance(10 ** 9, Infinity)).toEqual({ allowed: true, usage: 10 ** 9, cap: Infinity, remaining: Infinity })
  })
  it('fails CLOSED on a NaN/negative cap (treat as 0 → refuse new consumption)', () => {
    expect(decideAllowance(0, Number.NaN)).toMatchObject({ allowed: false, cap: 0, remaining: 0 })
    expect(decideAllowance(0, -5)).toMatchObject({ allowed: false, cap: 0, remaining: 0 })
  })
})

// Alerts fire ONCE per threshold per period — this function only reports which boundaries THIS
// increment passed (prev→next); the caller dedups durably via the ledger. Tested for the warn-then-cap
// pattern, single-step multi-cross, no re-fire, and inert uncapped.
describe('crossedThresholds (#128 usage alerts)', () => {
  it('reports a threshold newly crossed by this increment (80% warn)', () => {
    expect(crossedThresholds(70, 85, 100, [0.8, 1.0])).toEqual([0.8]) // 80 is in (70, 85]
  })
  it('does NOT re-report a threshold already passed before this increment', () => {
    expect(crossedThresholds(85, 95, 100, [0.8, 1.0])).toEqual([]) // 80 was already below prev
  })
  it('reports MULTIPLE thresholds crossed in one large increment, in order', () => {
    expect(crossedThresholds(10, 100, 100, [0.8, 1.0])).toEqual([0.8, 1.0]) // 80 and 100 both in (10,100]
  })
  it('crosses the cap itself (100%) when usage reaches it', () => {
    expect(crossedThresholds(90, 100, 100, [0.8, 1.0])).toEqual([1.0]) // 100 is in (90, 100]
  })
  it('never alerts when uncapped, when usage did not advance, or with a non-positive cap', () => {
    expect(crossedThresholds(10, 999, Infinity, [0.8, 1.0])).toEqual([])
    expect(crossedThresholds(90, 90, 100, [0.8, 1.0])).toEqual([]) // no advance
    expect(crossedThresholds(0, 50, 0, [0.8, 1.0])).toEqual([])
  })
  it('de-duplicates repeated thresholds in the input', () => {
    expect(crossedThresholds(0, 100, 100, [0.8, 0.8, 1.0])).toEqual([0.8, 1.0])
  })
})
