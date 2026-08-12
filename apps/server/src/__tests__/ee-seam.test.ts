// #178 / ADR-084: the EE feature mount seam mechanism. A CE / self-host build registers nothing, so
// getEeFeatures() is null and the CE core's `getEeFeatures()?.(host)` is a no-op (open-core default).
// An EE composition root registers a mount that then runs with the host. Verified with a real host
// object and a mount side effect (distinct pass/fail — not just "a function came back").
import { describe, it, expect, afterEach } from 'vitest'
import { registerEeFeatures, getEeFeatures, resetEeFeatures } from '@wikistead/hooks'

afterEach(() => resetEeFeatures())

describe('EE mount seam (registerEeFeatures / getEeFeatures)', () => {
  it('defaults to null — a CE build runs no EE features (open-core)', () => {
    // #688: the SUITE now runs as the EE composition (setup-ee-audit registers the audit mount for
    // every file), so the ambient value is non-null here by design. The CE default is still the
    // thing under test — observe it through reset, then restore the suite's registration.
    const suiteMount = getEeFeatures()
    resetEeFeatures()
    try {
      expect(getEeFeatures()).toBeNull()
    } finally {
      if (suiteMount) registerEeFeatures(suiteMount)
    }
  })

  it('runs the registered mount with the host the CE core passes', async () => {
    const seen: unknown[] = []
    registerEeFeatures((host) => { seen.push(host) })
    const mount = getEeFeatures()
    expect(mount).not.toBeNull()
    const host = { fga: {}, tag: 'host' }
    await mount!(host)
    expect(seen).toEqual([host]) // the exact host object reached the mount
  })

  it('reset restores the CE default (no leak between builds/tests)', () => {
    registerEeFeatures(() => {})
    expect(getEeFeatures()).not.toBeNull()
    resetEeFeatures()
    expect(getEeFeatures()).toBeNull()
  })
})
