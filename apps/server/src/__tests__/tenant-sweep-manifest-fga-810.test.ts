// ADR-252 §1 / #810: collectResetFgaObjectIds / resourceIdSetsForPolymorphicSweep. Pure functions
// (no DB/FGA call) — unit-level, unlike this ticket's other tenant-sweep pins.
import { describe, it, expect } from 'vitest'
import { collectResetFgaObjectIds, resourceIdSetsForPolymorphicSweep, reconstructDoomedIds, UnrecognisedFgaObjectError } from '../tenant-sweep/manifest-fga.js'
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

// review c-af763a4 (4th pass, F2 / 5th pass, G3): the exact inverse of `collectResetFgaObjectIds`
// above, used to reconstruct `DoomedIds` when RESUMING an unfinished sweep from a durable manifest.
describe('reconstructDoomedIds (ADR-252 §1, #810)', () => {
  it('round-trips this file\'s own fixture exactly (its ids already embed literal "space:"/"page:" text, so this also proves only the OUTER prefix collectResetFgaObjectIds adds is stripped)', () => {
    const objectIds = collectResetFgaObjectIds(doomed)
    expect(reconstructDoomedIds(objectIds)).toEqual(doomed)
  })

  it('round-trips a simple, unambiguous fixture exactly', () => {
    const simple: DoomedIds = { spaceIds: ['s1', 's2'], pageIds: ['p1'] }
    const objectIds = collectResetFgaObjectIds(simple)
    expect(reconstructDoomedIds(objectIds)).toEqual(simple)
  })

  // ⚠️ break-check (G3): the original version silently DROPPED any entry not `space:`/`page:`
  // prefixed instead of refusing — this directory's own convention everywhere else
  // (`UnclassifiableSchemaError`, `deriveResourceTypeTargets`'s `unknown`, `deriveStorageKeyColumns`'s
  // `unknown`) treats "found something this walk doesn't recognise" as fatal, not silently-skipped.
  it('⚠️ break-check: an unrecognised object prefix (e.g. a future template:/group:/tenant: entry) is fatal, not silently dropped', () => {
    expect(() => reconstructDoomedIds(['space:s1', 'template:t1', 'page:p1']))
      .toThrow(UnrecognisedFgaObjectError)
    try {
      reconstructDoomedIds(['space:s1', 'template:t1', 'page:p1'])
      expect.unreachable()
    } catch (e) {
      expect(e).toBeInstanceOf(UnrecognisedFgaObjectError)
      expect((e as UnrecognisedFgaObjectError).objects).toEqual(['template:t1'])
    }
  })
})
