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
import { isolatedStackFacts } from '../../../../infra/testing/isolated-stack.mjs'

const root = resolve(import.meta.dirname, '../../../..')

describe('#796: the collab suite is inside the isolated stack', () => {
  it('the stack marker says server-test — #269\'s valve, which this package got in #789', () => {
    expect(isolatedStackFacts(root).marker).toBe('server-test')
  })

  it('neither the database nor the permission store is the developer\'s own', (ctx) => {
    // A machine with no dev environment (public CI, a fresh clone) has nothing to be confused with,
    // and this SAYS SO rather than passing quietly: a green tick that compared nothing is how this
    // family keeps shipping. (The first version counted "compared plus skipped equals the total",
    // which is a tautology — the two sets are complements, so no input could fail it. An empty facts
    // list passed it too, which is the exact shape of every vacuous walk this repository has fixed.)
    const { facts } = isolatedStackFacts(root) as { facts: { what: string; actual?: string; dev: string | null }[] }
    // FIRST, before any skip can swallow it: an empty definition would make every loop below run
    // zero times, and a skip is not a finding — a definition that returned nothing has to be red
    // wherever it happens, including on the machine that has nothing to compare against.
    expect(facts.length, 'the shared definition returned no facts to check').toBeGreaterThan(1)
    const dev = facts.filter((f) => f.dev)
    if (dev.length === 0) {
      ctx.skip()
      return
    }

    for (const f of dev) {
      // A fact the dev environment names but this process does not is a finding, not a skip: the
      // suite is missing a variable it is supposed to have been given by the isolated stack.
      expect(f.actual, `${f.what} — this process has no value for it at all`).toBeTruthy()
      expect(f.actual, f.what).not.toBe(f.dev)
    }
  })
})
