// ADR-252 §1 / #810: collectResetFgaObjectIds / resourceIdSetsForPolymorphicSweep. Pure functions
// (no DB/FGA call) — unit-level, unlike this ticket's other tenant-sweep pins.
import { describe, it, expect } from 'vitest'
import { collectResetFgaObjectIds, resourceIdSetsForPolymorphicSweep } from '../tenant-sweep/manifest-fga.js'
import type { DoomedIds } from '../tenant-sweep/manifest-keys.js'

const doomed: DoomedIds = { spaceIds: ['space:doomed'], pageIds: ['page:kept', 'page:doomed'] }

describe('collectResetFgaObjectIds (ADR-252 §1, #810)', () => {
  it('formats every doomed space and every page (kept or not) as FGA object strings', () => {
    expect(collectResetFgaObjectIds(doomed).sort()).toEqual([
      'page:page:doomed',
      'page:page:kept',
      'space:space:doomed',
    ].sort())
  })

  it('never emits a tenant:, template: or group: object — reset does not touch those', () => {
    const ids = collectResetFgaObjectIds(doomed)
    for (const id of ids) expect(id).toMatch(/^(space|page):/)
  })

  // ⚠️ break-check: prove the "every page, kept or not" claim actually depends on doomed.pageIds
  // carrying the kept space's page — not an artifact of the fixture always including one.
  it('⚠️ break-check: a doomed.pageIds that omits the kept page produces a shorter, DIFFERENT list', () => {
    const withoutKept = collectResetFgaObjectIds({ spaceIds: doomed.spaceIds, pageIds: ['page:doomed'] })
    expect(withoutKept).not.toContain('page:page:kept')
    expect(withoutKept.length).toBeLessThan(collectResetFgaObjectIds(doomed).length)
  })
})

describe('resourceIdSetsForPolymorphicSweep (ADR-252 §1, #810)', () => {
  it('maps space-type resource_id matching to doomed spaces ONLY, and page-type to every page', () => {
    const sets = resourceIdSetsForPolymorphicSweep(doomed)
    expect(sets.space).toEqual(doomed.spaceIds)
    expect(sets.page).toEqual(doomed.pageIds)
    // the kept space's own id must never appear on the space side — that is the exact mistake §1's
    // own reason for shipping first (surviving share links) would be defeated by
    expect(sets.space).not.toContain('space:kept')
  })
})
