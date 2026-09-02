// #1022: a store id that no longer EXISTS is not the same as an empty store.
//
// THE DEFECT, measured 2026-09-01: `POST /stores/<dead>/read` answers 200 with `{"tuples":[]}` —
// exactly the shape `classifyAnchorRead` reads as "the tuple is gone" (#890's own fix drew the line
// between "could not ask" and "asked and it said no", but never asked whether the STORE it asked was
// the one this run means). A neighbouring checkout's un-offset `teardown:e2e` (`docker compose down
// -v`) tears down the shared default OpenFGA stack mid-run; this process's `webServer` still holds
// the store id it pinned at startup, so every one of the twelve reads answers the dead shape at once
// and `coreFixtureIntegrity` reported all twelve DELETED, naming whichever spec happened to finish
// first — the exact "confident wrong blame" #890 exists to prevent, from a second door.
//
// ⚠️ Imported at RUN time, not compile time, for the same reason the #890 pins beside this one do: a
// static import of the e2e harness is a build error under this package's `rootDir`, and loading a
// second copy of the function under test is the shape that lets it drift from the real one.
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

type FixtureIntegrity = { missing: string[]; unreadable: string[] }
let coreFixtureIntegrity: () => Promise<FixtureIntegrity>

const ROOT = resolve(import.meta.dirname, '../../../..')

beforeAll(async () => {
  const mod = (await import(pathToFileURL(resolve(ROOT, 'tests/e2e/fixtures.ts')).href)) as {
    coreFixtureIntegrity: typeof coreFixtureIntegrity
  }
  coreFixtureIntegrity = mod.coreFixtureIntegrity
  expect(coreFixtureIntegrity, 'the harness exports the function this file measures').toBeTypeOf('function')
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('#1022 a dead store refuses to blame a spec for tuples nobody deleted', () => {
  it('⚠️ store 404: every anchor comes back unreadable, none missing — the store, not a spec, is named', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        // The store-existence check (no trailing path beyond the id) is asked BEFORE any /read.
        if (!url.includes('/read')) return { ok: false, status: 404 } as Response
        // If the fix regressed to asking anyway, a 200-empty here would wrongly read as "missing" —
        // this proves the fix, not just documents it: the reads must never be reached at all.
        throw new Error('coreFixtureIntegrity asked a read after the store answered 404 — it must not')
      }),
    )
    const { missing, unreadable } = await coreFixtureIntegrity()
    expect(missing, 'a confirmed-dead store must name nobody').toEqual([])
    expect(unreadable.length, 'every anchor must be reported, all as unreadable').toBeGreaterThanOrEqual(10)
    expect(unreadable.every((u) => u.includes('does not exist')), unreadable.join('\n')).toBe(true)
  })

  it('⚠️ break-check the OTHER direction: a live store with a genuinely deleted anchor is still named', async () => {
    // Not vacuous: a fix that marks EVERY run unreadable (never blaming anybody, ever) would also
    // pass the case above. This is the case such a fix would fail — the real deletion #279/#890 exist
    // to catch must still surface.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (!url.includes('/read')) return { ok: true, status: 200 } as Response
        return { ok: true, status: 200, json: async () => ({ tuples: [] }) } as unknown as Response
      }),
    )
    const { missing, unreadable } = await coreFixtureIntegrity()
    expect(unreadable, 'a live store must not be reported unreadable').toEqual([]);
    expect(missing.length, 'a live store answering empty must still name the missing anchors').toBeGreaterThanOrEqual(10)
  })

  it('a live store with every anchor present reports neither missing nor unreadable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (!url.includes('/read')) return { ok: true, status: 200 } as Response
        return { ok: true, status: 200, json: async () => ({ tuples: [{ key: {} }] }) } as unknown as Response
      }),
    )
    const { missing, unreadable } = await coreFixtureIntegrity()
    expect({ missing, unreadable }).toEqual({ missing: [], unreadable: [] })
  })
})
