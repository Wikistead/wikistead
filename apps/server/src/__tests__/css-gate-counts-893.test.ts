// #893: the css-module guard says how much it scanned.
//
// THE DEFECT, in the same family as the licence gate that led this ticket: the guard walked
// apps/web/src, found no *.module.css, and printed "OK: no *.module.css under apps/web/src". A walk
// that reached nothing prints the identical sentence. Measured 2026-08-22 before the fix: pointing
// the scan at a directory that does not exist left it exiting 0 with that same line.
//
// The licence half of this ticket landed separately (`license-gate-counts-893.test.ts`); this is the
// other script that carried the shape, and the rule is the one #719 already wrote for the publication
// layers — an empty check is not a pass.
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const GUARD = resolve(import.meta.dirname, '../../../../scripts/check-no-css-modules.mjs')

describe('#893 the css-module guard cannot report a tree it never read', () => {
  it('is where this repository says it is', () => {
    // The guard moving would empty every case below.
    expect(existsSync(GUARD)).toBe(true)
  })

  const src = existsSync(GUARD) ? readFileSync(GUARD, 'utf8') : ''

  it('fails when its walk reached nothing', () => {
    expect(src).toMatch(/scanned === 0[\s\S]{0,300}process\.exit\(1\)/)
  })

  it('counts every file it looked at, not only the offenders', () => {
    // Counting only matches would leave the count at zero on a clean tree, which is the number the
    // broken walk also produces — the two states have to be told apart.
    expect(src).toMatch(/scanned\+\+/)
  })

  it('carries the count into the success line', () => {
    expect(src).toMatch(/OK: \$\{scanned\}/)
  })

  it('still fails on an offender, which is what it was written for', () => {
    expect(src).toMatch(/offenders\.length > 0[\s\S]{0,400}process\.exit\(1\)/)
  })
})
