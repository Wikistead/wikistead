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
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

type Verdict = { kind: 'present' } | { kind: 'missing' } | { kind: 'unreadable'; why: string }
let classifyAnchorRead: (res: { ok: boolean; status: number } | null, body: unknown, error?: unknown) => Verdict

const ROOT = resolve(import.meta.dirname, '../../../..')
const FIXTURES_PATH = resolve(ROOT, 'tests/e2e/fixtures.ts')
const REPORTER_PATH = resolve(ROOT, 'tests/e2e/fixture-guard-reporter.ts')

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

})

// #890 (review, 2026-08-28): the two call sites above used to be checked by grepping their
// SOURCE for `unreadable.length > 0` — which stays true when the `if` guard is left standing but its
// EFFECT is gutted (the reporter's `return; // and do NOT blame anybody` deleted, or
// `assertDemoFixtureIntact`'s unreadable-branch `throw` emptied out). The reviewer applied both mutations
// by hand and both pins stayed green. These describes replace that grep with the real call sites, run.
describe('#890 the reporter actually withholds blame on an unreadable store, not just mentions it', () => {
  afterEach(() => {
    vi.doUnmock(FIXTURES_PATH)
    vi.restoreAllMocks()
  })

  type FakeTest = { location: { file: string }; title: string }
  type ReporterInstance = { onTestEnd(test: FakeTest, result: unknown): void; onEnd(): Promise<void> }
  type ReporterCtor = new () => ReporterInstance

  async function loadReporterSeeing(integrity: { missing: string[]; unreadable: string[] }): Promise<ReporterCtor> {
    vi.resetModules()
    vi.doMock(FIXTURES_PATH, () => ({ coreFixtureIntegrity: async () => integrity }))
    const mod = (await import(pathToFileURL(REPORTER_PATH).href)) as { default: ReporterCtor }
    return mod.default
  }

  it('mixed unreadable+missing: names nobody — MUTATION: deleting the guard\'s `return` names the spec anyway', async () => {
    // A store that answered for SOME anchors and not others is exactly the case the guard exists for:
    // the real deletion below must NOT surface while any anchor is unreadable, because a partial read
    // proves nothing about the anchors it never reached.
    const Reporter = await loadReporterSeeing({
      missing: ['user:dev-user#manager@space:demo_space'],
      unreadable: ['page:demo: 500 deadline_exceeded'],
    })
    const seen: string[] = []
    vi.spyOn(console, 'error').mockImplementation((msg: unknown) => void seen.push(String(msg)))
    const reporter = new Reporter()
    reporter.onTestEnd({ location: { file: '/fake/innocent.spec.ts' }, title: 'sentinel' }, {})
    await reporter.onEnd()
    expect(seen.some((m) => m.includes('SHARED FIXTURE BROKEN'))).toBe(false)
    expect(seen.some((m) => m.includes('COULD NOT RUN'))).toBe(true)
  })

  it('a clean read of a real deletion still names the spec (the guard must not swallow everything)', async () => {
    const Reporter = await loadReporterSeeing({ missing: ['user:dev-user#manager@space:demo_space'], unreadable: [] })
    const seen: string[] = []
    vi.spyOn(console, 'error').mockImplementation((msg: unknown) => void seen.push(String(msg)))
    const reporter = new Reporter()
    reporter.onTestEnd({ location: { file: '/fake/culprit.spec.ts' }, title: 'the actual culprit' }, {})
    await reporter.onEnd()
    expect(seen.some((m) => m.includes('SHARED FIXTURE BROKEN') && m.includes('culprit.spec.ts'))).toBe(true)
  })
})

describe('#890 assertDemoFixtureIntact actually fails closed on an unreadable store', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.doUnmock('node:fs')
    vi.resetModules()
  })

  // fgaEnv() reads the two e2e env files by URL via `readFileSync` — mocking just that call (falling
  // through to the real one for every other path) points it at a fake store without touching disk, so
  // this exercises the real `fetch` call inside `coreFixtureIntegrity`/`assertDemoFixtureIntact` end to
  // end rather than a copy of their logic.
  async function loadAssertReading(fetchImpl: typeof fetch): Promise<() => Promise<void>> {
    vi.resetModules()
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs')>()
      const readFileSync = ((path: unknown, options?: unknown) => {
        const target = String(path)
        if (target.endsWith('.env.e2e.local')) {
          return 'OPENFGA_STORE_ID=test-store-890\nOPENFGA_MODEL_ID=test-model-890\nOPENFGA_API_URL=http://fixture-guard-890.invalid\n'
        }
        if (target.endsWith('.env.e2e')) return ''
        return (actual.readFileSync as (...a: unknown[]) => unknown)(path, options)
      }) as typeof actual.readFileSync
      return { ...actual, readFileSync }
    })
    vi.stubGlobal('fetch', fetchImpl)
    const mod = (await import(pathToFileURL(FIXTURES_PATH).href)) as { assertDemoFixtureIntact: () => Promise<void> }
    return mod.assertDemoFixtureIntact
  }

  it('MUTATION: emptying the unreadable-branch `throw` would report "fine" — the real code must reject', async () => {
    const fetchImpl = (async () => ({ ok: false, status: 500, text: async () => 'deadline_exceeded' })) as unknown as typeof fetch
    const assertDemoFixtureIntact = await loadAssertReading(fetchImpl)
    await expect(assertDemoFixtureIntact()).rejects.toThrow(/could not be asked/)
  })

  it('still throws on a genuine deletion (an unreadable-only fix must not swallow this too)', async () => {
    let call = 0
    const fetchImpl = (async () => {
      call += 1
      const tuples = call === 1 ? [] : [{ key: {} }]
      return { ok: true, status: 200, json: async () => ({ tuples }), text: async () => '' }
    }) as unknown as typeof fetch
    const assertDemoFixtureIntact = await loadAssertReading(fetchImpl)
    await expect(assertDemoFixtureIntact()).rejects.toThrow(/DELETED/)
  })

  it('resolves when every anchor reads back present', async () => {
    const fetchImpl = (async () => ({ ok: true, status: 200, json: async () => ({ tuples: [{ key: {} }] }), text: async () => '' })) as unknown as typeof fetch
    const assertDemoFixtureIntact = await loadAssertReading(fetchImpl)
    await expect(assertDemoFixtureIntact()).resolves.toBeUndefined()
  })
})
