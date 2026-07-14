// #383 / ADR-152 §1 (Option B, ratified 2026-07-15): the EE authz hook layer interposes on the
// page/space capability seam ONLY — `check()` (and what is built on it, e.g. filterAuthorized). The
// other primitives are NON-interposed by design: checkRelation (raw relation reads, incl. the anonymous
// public reader) and checkMemberAccess (collab's RW/RO/reject batch). This test PINS the declared scope
// to reality in both directions — a change that widens the seam (hooks suddenly running on collab /
// public / admin paths) or narrows it (check() silently dropping the hooks) fails here and requires
// re-opening ADR-152. Fake FGA + real registerAuthzHooks; hooks are reset after every test (the registry
// is module-global — leaking a deny hook would fail unrelated suites).
import { describe, it, expect, afterEach } from 'vitest'
import type { OpenFgaClient } from '@openfga/sdk'
import { check, checkRelation, checkMemberAccess, filterAuthorized } from '@wikistead/authz'
import { registerAuthzHooks } from '@wikistead/hooks'

function fakeFga(allowed: boolean) {
  const calls: { user: string; relation: string; object: string }[] = []
  const client = {
    check: async (req: { user: string; relation: string; object: string }) => {
      calls.push({ user: req.user, relation: req.relation, object: req.object })
      return { allowed }
    },
    batchCheck: async ({ }: never[] | object) => ({
      responses: [
        { _request: { relation: 'edit' }, allowed },
        { _request: { relation: 'view' }, allowed: true },
      ],
    }),
  } as unknown as OpenFgaClient
  return { client, calls }
}

// Registers spy hooks and returns their call logs. beforeVerdict/afterVerdict control short-circuit /
// override behaviour (undefined = pass through, the no-op contract).
function spyHooks(opts: { beforeVerdict?: boolean; afterVerdict?: boolean } = {}) {
  const beforeCalls: { relation: string }[] = []
  const afterCalls: { relation: string; fgaResult: boolean }[] = []
  registerAuthzHooks({
    beforeCheck: async (ctx) => { beforeCalls.push({ relation: ctx.relation }); return opts.beforeVerdict },
    afterCheck: async (ctx, fgaResult) => { afterCalls.push({ relation: ctx.relation, fgaResult }); return opts.afterVerdict },
  })
  return { beforeCalls, afterCalls }
}

afterEach(() => {
  // Restore the unregistered (no-op) state — the registry merges, so overwrite with undefined.
  registerAuthzHooks({ beforeCheck: undefined, afterCheck: undefined })
})

describe('EE authz hook scope (#383 / ADR-152 Option B — declared scope matches reality)', () => {
  it('check() IS interposed: beforeCheck can short-circuit (FGA never called), afterCheck can override', async () => {
    // beforeCheck short-circuit: deny before FGA.
    {
      const { client, calls } = fakeFga(true)
      const { beforeCalls, afterCalls } = spyHooks({ beforeVerdict: false })
      expect(await check(client, 'user:u', 'view', { type: 'page', id: 'p1' })).toBe(false)
      expect(beforeCalls).toHaveLength(1)
      expect(beforeCalls[0]!.relation).toBe('view')
      expect(calls).toHaveLength(0) // short-circuited — FGA untouched
      expect(afterCalls).toHaveLength(0)
      registerAuthzHooks({ beforeCheck: undefined, afterCheck: undefined })
    }
    // afterCheck override: FGA allowed, hook denies.
    {
      const { client, calls } = fakeFga(true)
      const { afterCalls } = spyHooks({ afterVerdict: false })
      expect(await check(client, 'user:u', 'edit', { type: 'space', id: 's1' })).toBe(false)
      expect(calls).toHaveLength(1) // FGA consulted...
      expect(afterCalls).toEqual([{ relation: 'editor', fgaResult: true }]) // ...and the hook saw its verdict
    }
  })

  it('filterAuthorized inherits the interposition (it is built on check())', async () => {
    const { client } = fakeFga(true)
    const { afterCalls } = spyHooks({ afterVerdict: false }) // deny everything post-FGA
    const allowed = await filterAuthorized(client, 'user:u', 'view', ['a', 'b'])
    expect(allowed.size).toBe(0)
    expect(afterCalls).toHaveLength(2)
  })

  it('checkRelation is NOT interposed (by design — raw reads, public reader, and hook self-reads)', async () => {
    const { client, calls } = fakeFga(true)
    const { beforeCalls, afterCalls } = spyHooks({ beforeVerdict: false, afterVerdict: false }) // would deny if consulted
    expect(await checkRelation(client, 'user:anonymous', 'view', { type: 'page', id: 'p1' })).toBe(true)
    expect(calls).toHaveLength(1)
    expect(beforeCalls).toHaveLength(0)
    expect(afterCalls).toHaveLength(0)
  })

  it('checkMemberAccess (collab RW/RO/reject) is NOT interposed (by design — DSL subtractions reach it instead)', async () => {
    const { client } = fakeFga(true)
    const { beforeCalls, afterCalls } = spyHooks({ beforeVerdict: false, afterVerdict: false })
    const access = await checkMemberAccess(client, 'u', { type: 'page', id: 'p1' })
    expect(access).toEqual({ readOnly: false }) // the registered deny hooks did NOT flip this
    expect(beforeCalls).toHaveLength(0)
    expect(afterCalls).toHaveLength(0)
  })

  it('unregistered hooks are a strict no-op (undefined return = pass through the FGA verdict)', async () => {
    const { client } = fakeFga(true)
    expect(await check(client, 'user:u', 'view', { type: 'page', id: 'p1' })).toBe(true)
    const denied = fakeFga(false)
    expect(await check(denied.client, 'user:u', 'view', { type: 'page', id: 'p1' })).toBe(false)
  })
})
