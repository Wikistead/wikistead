// #819: the server suite asserts what it is CONNECTED to, not only what its marker says.
//
// This package holds the destructive tests — billing wipes spaces, the tenant and plan tests mutate
// and delete members — and it was the one package of the three with half the guard. The half it had
// is #269's valve in vitest.config.ts, which refuses to start unless WIKISTEAD_TEST_STACK reads
// 'server-test'. That marker is a string in an env file, so "the marker is set and DATABASE_URL
// points at the developer's own database" walks straight through it — which is the exact state #787
// found the EE package in, for two months.
//
// The other two packages grew the missing half (#787 for the EE package, #796 for collab) and this
// one did not, so the package that would do the most damage was the least measured.
import { describe, it, expect } from 'vitest'
import { resolve } from 'node:path'
// @ts-expect-error — plain .mjs, deliberately not a TS module (each package has its own rootDir)
import { isolatedStackVerdict } from '../../../../infra/testing/isolated-stack.mjs'

const root = resolve(import.meta.dirname, '../../../..')

type Verdict = { marker?: string; definitionEmpty: boolean; compared: number; problems: string[] }

describe('#819: the server suite is inside the isolated stack', () => {
  it('the stack marker says server-test — #269\'s valve, the half this package already had', () => {
    expect((isolatedStackVerdict(root) as Verdict).marker).toBe('server-test')
  })

  it('neither the database nor the permission store is the developer\'s own', (ctx) => {
    // The verdict comes from the shared definition rather than from a comparison written here: three
    // packages needing the same rule is how this family started, and #796 already measured what a
    // per-package copy costs. The values are compared against the dev FILE, never a hard-coded url —
    // every session runs its own port offset, so a literal would be wrong for two of three.
    const verdict = isolatedStackVerdict(root) as Verdict
    // FIRST, before the skip below can swallow it: a definition that returned nothing has to be red
    // wherever it happens, including on the machine that has nothing to compare against.
    expect(verdict.definitionEmpty, 'the shared definition returned no facts to check').toBe(false)
    if (verdict.compared === 0) {
      // No dev environment here (public CI, a fresh clone) — nothing to be confused with, and this
      // SAYS so rather than passing quietly.
      ctx.skip()
      return
    }
    expect(verdict.problems, `compared ${verdict.compared} value(s) with the dev environment`).toEqual([])
  })
})
