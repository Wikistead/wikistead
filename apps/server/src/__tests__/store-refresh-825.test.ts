// #825: a test run starts from a permission store it can answer from.
//
// #823 rotated the store at `setup:server-test` and stopped there, so it gets fat again during the
// session that set it up. Measured on one session's stack, the same 50-wide `page#view` batch: 3.9-5.0
// ms per id just after a rotation, 19.3 ms after two full runs (48,364 tuples), and — on the stack
// #825 was filed from — about 70 ms with only 14 to 18 of the 50 answering at all. The suites that
// notice are whichever ones batch authorization checks, and they notice as a standing red from a diff
// that touched none of them.
//
// Two things are pinned here, and neither of them is a duration (machine speed is not an assertion —
// #755 the rule):
//   1. the DECISION, in every branch, including the two refusals that keep this away from a store it
//      cannot prove is throwaway;
//   2. that a run actually asks the question, and that the rotation steps exist in ONE place — the
//      shape that made this defect possible was `setup:server-test` owning a sequence nobody else
//      could reuse.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
// @ts-expect-error — plain .mjs, deliberately not a TS module (#621 convention)
import { refreshVerdict, shouldRotate, REFRESH_THRESHOLD } from '../../../../scripts/server-test-store.mjs'
// #178: where the EE package lives is one file's business, and #785: a CE test may not read a path
// the publication erases. Both are answered by asking rather than spelling — `null` is a CE-only tree,
// where that package is simply not one of the ones sharing the stack.
// @ts-expect-error — repo-root script module, no types (#621 convention)
import { eeServerSourceRoot } from '../../../../scripts/ee-source-root.mjs'

const root = resolve(import.meta.dirname, '../../../..')
const read = (rel: string) => readFileSync(resolve(root, rel), 'utf8')
const readAbs = (abs: string) => readFileSync(abs, 'utf8')

describe('#825: the decision, in every branch', () => {
  const fat = (REFRESH_THRESHOLD as number) + 1

  it('refuses a tree with no isolated stack, and a stack that is not the throwaway one', () => {
    // A fresh clone and the public CI before its setup step both land here; so does anything whose
    // marker says it is somebody's development stack (#269's valve, the one this must never cross).
    expect(refreshVerdict({ hasLocalEnv: false, marker: 'server-test', tuples: fat })).toBe('no-stack')
    expect(refreshVerdict({ hasLocalEnv: true, marker: undefined, tuples: fat })).toBe('not-mine')
    expect(refreshVerdict({ hasLocalEnv: true, marker: 'dev', tuples: fat })).toBe('not-mine')
  })

  it('leaves the store alone when it will not say how big it is', () => {
    // The stack being down, or OpenFGA renaming its own tables, must not take a test run with it:
    // whatever runs next fails on its own terms and says something more useful than this step could.
    expect(refreshVerdict({ hasLocalEnv: true, marker: 'server-test', tuples: null })).toBe('unknown')
    expect(refreshVerdict({ hasLocalEnv: true, marker: 'server-test', tuples: undefined })).toBe('unknown')
  })

  it('rotates only above the threshold — at it is not over it', () => {
    expect(refreshVerdict({ hasLocalEnv: true, marker: 'server-test', tuples: 0 })).toBe('keep')
    expect(refreshVerdict({ hasLocalEnv: true, marker: 'server-test', tuples: REFRESH_THRESHOLD })).toBe('keep')
    expect(refreshVerdict({ hasLocalEnv: true, marker: 'server-test', tuples: fat })).toBe('rotate')
    expect(shouldRotate(REFRESH_THRESHOLD as number)).toBe(false)
    expect(shouldRotate(fat)).toBe(true)
  })

  it('the threshold is under what was measured to hurt', () => {
    // 48,364 tuples cost 4.4x per check and a full run leaves roughly half of that, so the check has
    // to bite before a second run lands on the first. A threshold at or above the measured figure
    // would be a knob that never turns.
    expect(REFRESH_THRESHOLD as number).toBeLessThan(48_364)
    expect(REFRESH_THRESHOLD as number).toBeGreaterThan(0)
  })
})

describe('#825: a run asks the question, and the sequence lives in one place', () => {
  it('`pnpm test` runs the refresh before turbo fans out', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> }
    expect(pkg.scripts.test, 'the root test script must refresh the store first').toContain('server-test-refresh.mjs')
    expect(pkg.scripts.test.indexOf('server-test-refresh.mjs'))
      .toBeLessThan(pkg.scripts.test.indexOf('turbo run test'))
    // Runnable on its own too: a session that ran one package and wants a clean store next time needs
    // a command to say so, not a comment telling it to read the root script.
    expect(pkg.scripts['test:refresh-store']).toContain('server-test-refresh.mjs')
  })

  it('no per-package test script rotates the store', () => {
    // Turbo runs the packages against ONE stack at the same time. A rotation from a sibling's entry
    // point takes the model id out from under a suite already running — `authorization_model_not_found`,
    // which #789 spent a day reading as a product bug.
    const ee = eeServerSourceRoot(root) as string | null
    const manifests = [
      resolve(root, 'apps/server/package.json'),
      resolve(root, 'apps/collab/package.json'),
      ...(ee ? [join(ee, '..', 'package.json')] : []),
    ]
    expect(manifests.length, 'nothing to check').toBeGreaterThan(0)
    for (const p of manifests) {
      const pkg = JSON.parse(readAbs(p)) as { scripts?: Record<string, string> }
      expect(pkg.scripts?.test ?? '', `${p} must not rotate the shared store`).not.toContain('server-test-refresh')
      expect(pkg.scripts?.test ?? '', `${p} must not retire the shared store`).not.toContain('reset-test-store')
    }
  })

  it('only one file knows how to retire and re-bootstrap the store', () => {
    // The defect's shape: `setup:server-test` owned a sequence nobody else could reuse, so the only
    // way to get a clean store was to stand the whole stack up again. Two copies would go stale apart.
    const callers = ['scripts/server-test-up.mjs', 'scripts/server-test-refresh.mjs', 'scripts/server-test-store.mjs']
    const owners = callers.filter((f) => read(f).includes('reset-test-store.ts'))
    expect(owners, 'the retire step must appear in exactly one module').toEqual(['scripts/server-test-store.mjs'])
    // …and the callers must actually go through it, or "one place" is true and useless.
    for (const f of ['scripts/server-test-up.mjs', 'scripts/server-test-refresh.mjs']) {
      expect(read(f), `${f} must call the shared rotation`).toContain('rotateStore')
    }
  })
})
