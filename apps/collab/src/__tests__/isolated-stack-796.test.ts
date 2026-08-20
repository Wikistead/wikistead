// #796 (from #789's review): collab asserts what it is connected to, the way the EE package does.
//
// #789 pointed this suite at the isolated stack and put #269's valve in front of it. What it did not
// get was the half that keeps the fix true tomorrow: the EE package asks its RUNNING process which
// database and permission store it reached (#787), and collab had nothing — so the next time somebody
// copies a config across packages, the copy could drift back and only a hand-run break-check would
// notice.
//
// These suites write tenants, spaces and permission tuples. Pointed at the dev stack, a test run edits
// the owner's data; pointed at another session's stack, it corrupts a neighbour's run.
import { describe, it, expect } from 'vitest'
import { resolve } from 'node:path'
// @ts-expect-error — plain .mjs, deliberately not a TS module (each package has its own rootDir)
import { isolatedStackVerdict } from '../../../../infra/testing/isolated-stack.mjs'

const root = resolve(import.meta.dirname, '../../../..')

type Verdict = { marker?: string; definitionEmpty: boolean; compared: number; problems: string[] }

describe('#796: the collab suite is inside the isolated stack', () => {
  it('the stack marker says server-test — #269\'s valve, which this package got in #789', () => {
    expect((isolatedStackVerdict(root) as Verdict).marker).toBe('server-test')
  })

  it('neither the database nor the permission store is the developer\'s own', (ctx) => {
    // #819: the verdict is the shared definition's now, not a comparison restated here. This pin used
    // to carry its own copy of the rule — an empty definition is red, no dev environment is a declared
    // skip, a missing value is a finding and not a skip — and so did the EE one. Two copies of a rule
    // is the shape this whole family is made of. (The tautology the first version measured, "compared
    // plus skipped equals the total", is gone with it: no input could ever have failed it.)
    const verdict = isolatedStackVerdict(root) as Verdict
    // FIRST, before any skip can swallow it: a definition that returned nothing has to be red
    // wherever it happens, including on the machine that has nothing to compare against.
    expect(verdict.definitionEmpty, 'the shared definition returned no facts to check').toBe(false)
    if (verdict.compared === 0) {
      // A machine with no dev environment (public CI, a fresh clone) has nothing to be confused with,
      // and this SAYS SO rather than passing quietly: a green tick that compared nothing is how this
      // family keeps shipping.
      ctx.skip()
      return
    }
    expect(verdict.problems, `compared ${verdict.compared} value(s) with the dev environment`).toEqual([])
  })
})
