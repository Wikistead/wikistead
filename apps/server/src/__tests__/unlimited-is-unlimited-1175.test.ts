// #1175 (review, 2026-09-06): the self-host build cannot show an upgrade prompt, and the reason is
// not the UI hiding one — it is that self-host registers no entitlement resolver, so every lever
// resolves to UNLIMITED (packages/entitlements/src/index.ts; ADR-069 makes this structural, no env
// flag). The server never answers an entitlement refusal, so the condition under which
// `UpgradeNotice` renders never arises. That whole argument rests on ONE object: UNLIMITED must be
// unlimited on every lever.
//
// Nothing pinned that. `cloud-plan-table-464` guards the KEY SET (every Cloud row carries exactly
// UNLIMITED's keys), one value (`analytics`), and one pairing (`scim`/`auditLog`). A new boolean
// lever written into UNLIMITED as a natural-default `false` keeps the key set identical, passes the
// structural pin, and silently removes a feature from every self-host — while pointing the operator
// at a plan they cannot buy. This pin closes that: every boolean is true, every number is Infinity,
// recursively, and the walk refuses a shape it does not know rather than skipping it.
//
// Pure unit test (no DB / FGA): safe anywhere the server suite runs.
import { describe, it, expect } from 'vitest'
import { UNLIMITED } from '@wikistead/entitlements'

type Leaf = { path: string; value: unknown }

// Walks a lever set and returns every leaf that is NOT unlimited, plus how many leaves it judged —
// the count is the vacuity guard (a walker that visits nothing would "find" nothing wrong).
function limitedLeaves(obj: Record<string, unknown>, prefix = ''): { limited: Leaf[]; visited: number } {
  const limited: Leaf[] = []
  let visited = 0
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (typeof value === 'boolean') {
      visited++
      if (value !== true) limited.push({ path, value })
    } else if (typeof value === 'number') {
      visited++
      if (value !== Infinity) limited.push({ path, value })
    } else if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const inner = limitedLeaves(value as Record<string, unknown>, path)
      limited.push(...inner.limited)
      visited += inner.visited
    } else {
      // A shape this pin cannot judge (a string, an array, null). Refusing is the point: a lever the
      // walk would silently skip is a lever that could be limited on self-host without this going red.
      limited.push({ path, value: `unjudged shape: ${Array.isArray(value) ? 'array' : typeof value}` })
    }
  }
  return { limited, visited }
}

describe('#1175: UNLIMITED is unlimited on every lever — the self-host no-upgrade-prompt guarantee', () => {
  it('every boolean is true and every number is Infinity, on every lever, recursively', () => {
    const { limited, visited } = limitedLeaves(UNLIMITED as unknown as Record<string, unknown>)
    expect(visited, 'the walk must actually judge the lever set (vacuity guard)').toBeGreaterThanOrEqual(20)
    expect(limited, 'a limited lever on self-host would surface an upgrade prompt for a plan nobody can buy').toEqual([])
  })

  it('covers every key the Entitlements interface declares (no lever escapes the walk)', () => {
    // The same key set cloud-plan-table-464 pins the Cloud rows against; here it proves the walk
    // above saw ALL of them, not a subset — the count guard alone would accept a walk over 20 of 26.
    const { visited } = limitedLeaves(UNLIMITED as unknown as Record<string, unknown>)
    const topLevel = Object.keys(UNLIMITED).length
    const nested = Object.values(UNLIMITED).filter((v) => v !== null && typeof v === 'object').length
    // Each nested object contributes its own leaves instead of one; every real nested lever today is
    // the {perKey, perTenant} pair, so the count is (top-level minus nested) plus the pairs' leaves.
    const nestedLeaves = Object.values(UNLIMITED)
      .filter((v): v is Record<string, unknown> => v !== null && typeof v === 'object')
      .reduce((n, v) => n + Object.keys(v).length, 0)
    expect(visited).toBe(topLevel - nested + nestedLeaves)
  })

  // ⚠️ Break-check on a synthetic row (the #925 pattern): the assertion is not vacuously green just
  // because the real object happens to comply — the same walker rejects each way a lever can be
  // limited, and refuses a shape it cannot judge.
  it('⚠️ break-check: a false boolean, a finite number, a nested limit and an unjudged shape are each REJECTED', () => {
    expect(limitedLeaves({ a: false }).limited.map((l) => l.path)).toEqual(['a'])
    expect(limitedLeaves({ n: 10 }).limited.map((l) => l.path)).toEqual(['n'])
    expect(limitedLeaves({ r: { perKey: Infinity, perTenant: 100 } }).limited.map((l) => l.path)).toEqual(['r.perTenant'])
    expect(limitedLeaves({ s: 'team' }).limited.map((l) => l.path)).toEqual(['s'])
    expect(limitedLeaves({ ok: true, big: Infinity, pair: { perKey: Infinity, perTenant: Infinity } }).limited).toEqual([])
  })
})
