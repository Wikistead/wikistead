// #890: the integrity check tells "gone" apart from "I could not ask".
//
// THE DEFECT, measured 2026-08-23 on a real run: the check decided absence from `json.tuples` being
// empty, and an error body — `{}`, the fallback after a failed `.json()` — has the same shape as an
// answer with no tuples. When OpenFGA wedged at its 3 s deadline mid-run (Postgres beside it healthy,
// 1,861 tuples, nothing wrong with the data), the check reported ALL TWELVE anchors as deleted and the
// reporter named `loading-skeleton-457.spec.ts` — a spec that touches none of them. Restarting the
// store brought every anchor back, so nothing had been deleted at any point.
//
// That is worse than the failure this instrumentation replaced. Before it, a broken run said "something
// deleted the fixture" and left the reader to look; after it, the run accuses a named innocent, and the
// reader believes it. `seedFgaFixtures` already draws this line on the WRITE side ("self-healing that
// cannot heal has to say so") — only the read side was left best-effort.
//
// ⚠️ The verdict is a PURE function so this pin can RUN it. A pin that greps `fixtures.ts` for the word
// "unreadable" would pass over a branch that is never reached, and the branch is the whole subject.
//
// ⚠️ Imported at RUN time, not compile time: `tsc` holds this package to its own `rootDir`, so a static
// import of the harness is a build error (which is why the neighbouring #890 pin reads that file as
// text). Loading it here keeps the pin measuring the real function rather than a copy of it — a second
// copy of this classifier is exactly the shape that lets the two drift apart.
import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

type Verdict = { kind: 'present' } | { kind: 'missing' } | { kind: 'unreadable'; why: string }
let classifyAnchorRead: (res: { ok: boolean; status: number } | null, body: unknown, error?: unknown) => Verdict

const ROOT = resolve(import.meta.dirname, '../../../..')

beforeAll(async () => {
  const mod = (await import(pathToFileURL(resolve(ROOT, 'tests/e2e/fixtures.ts')).href)) as {
    classifyAnchorRead: typeof classifyAnchorRead
  }
  classifyAnchorRead = mod.classifyAnchorRead
  expect(classifyAnchorRead, 'the harness exports the verdict function this file measures').toBeTypeOf('function')
})

describe('#890 the fixture check separates absence from unreachability', () => {
  it('a 200 that carries a tuple is present', () => {
    expect(classifyAnchorRead({ ok: true, status: 200 }, { tuples: [{ key: {} }] })).toEqual({ kind: 'present' })
  })

  it('a 200 that carries none is missing — the real deletion still gets named', () => {
    // The half that keeps the fix from being "call everything unreadable and never blame anybody".
    expect(classifyAnchorRead({ ok: true, status: 200 }, { tuples: [] })).toEqual({ kind: 'missing' })
  })

  it('⚠️ a store that refuses is unreadable, not empty', () => {
    // The measured case: 500 / "Request Deadline Exceeded" on every read.
    const v = classifyAnchorRead({ ok: false, status: 500 }, 'Request Deadline Exceeded')
    expect(v.kind).toBe('unreadable')
    expect(v.kind === 'unreadable' && v.why).toContain('500')
  })

  it('⚠️ a request that never arrived is unreadable', () => {
    const v = classifyAnchorRead(null, undefined, new TypeError('fetch failed'))
    expect(v.kind).toBe('unreadable')
    expect(v.kind === 'unreadable' && v.why).toContain('fetch failed')
  })

  it('⚠️ a 200 whose body will not parse is unreadable, not empty', () => {
    // This is the exact shape the old code turned into a deletion: `.json()` threw, the catch produced
    // `{}`, and `!({}).tuples` read as "the tuple is gone".
    expect(classifyAnchorRead({ ok: true, status: 200 }, undefined).kind).toBe('unreadable')
  })

  it('⚠️ and a 200 without a tuples array is unreadable, not empty', () => {
    expect(classifyAnchorRead({ ok: true, status: 200 }, {}).kind).toBe('unreadable')
    expect(classifyAnchorRead({ ok: true, status: 200 }, { tuples: 'nope' }).kind).toBe('unreadable')
  })

  it('the reporter and the teardown both consult the unreadable list before blaming', () => {
    // Both callers decide whether to NAME somebody, and the decision is made in their own file. The
    // classifier cannot enforce that, so the two call sites are read here — the only structural claim
    // in this file, and it is about which list is consulted, not about any wording.
    for (const f of ['tests/e2e/fixture-guard-reporter.ts', 'tests/e2e/fixtures.ts']) {
      const src = readFileSync(resolve(ROOT, f), 'utf8')
      expect(src, `${f} reads the three-valued result`).toContain('coreFixtureIntegrity')
      expect(src, `${f} acts on the unreadable list`).toMatch(/unreadable\.length > 0/)
    }
  })
})
