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

  it('neither the database nor the permission store is the developer\'s own', () => {
    // Skipped value by value rather than as a whole: a machine with no dev environment (CI, a fresh
    // clone) has nothing to be confused with, and a suite that silently asserts nothing there is the
    // failure this family keeps producing — so the count of what was compared is part of the message.
    const { facts } = isolatedStackFacts(root) as { facts: { what: string; actual?: string; dev: string | null }[] }
    const compared: string[] = []
    for (const f of facts) {
      if (!f.dev || !f.actual) continue
      compared.push(f.what)
      expect(f.actual, f.what).not.toBe(f.dev)
    }
    expect(compared.length + facts.filter((f) => !f.dev || !f.actual).length, 'every fact was either compared or had no dev value to compare with').toBe(facts.length)
  })
})
