// Capability -> FGA relation mapping (packages/authz check.ts) — the single chokepoint EVERY
// application authorization goes through. A wrong string here (e.g. space edit -> 'edit' instead of
// the model's 'editor') is a silent authz break. The integration suite (authz.test.ts) exercises this
// only against a live OpenFGA with seeded data; this pins the MAPPING itself, fast and in isolation,
// with a fake FGA that captures the relation actually sent. Distinct expected relation per capability
// so a table typo is caught, and the undefined case (space+comment) must THROW, never silently allow.
import { describe, it, expect } from 'vitest'
import type { OpenFgaClient } from '@openfga/sdk'
import { check, checkMemberAccess } from '@wikistead/authz'
import type { Capability } from '@wikistead/types'

// A fake FGA that records each check() request and returns a fixed verdict.
function fakeFga(allowed: boolean) {
  const calls: { user: string; relation: string; object: string }[] = []
  const client = {
    check: async (req: { user: string; relation: string; object: string }) => {
      calls.push({ user: req.user, relation: req.relation, object: req.object })
      return { allowed }
    },
  } as unknown as OpenFgaClient
  return { client, calls }
}

describe('capability -> FGA relation mapping (authz chokepoint)', () => {
  it('maps PAGE capabilities to the same-named relations', async () => {
    const cases: [Capability, string][] = [['view', 'view'], ['comment', 'comment'], ['edit', 'edit'], ['manage', 'manage']]
    for (const [cap, rel] of cases) {
      const { client, calls } = fakeFga(true)
      await check(client, 'user:u', cap, { type: 'page', id: 'p1' })
      expect(calls.at(-1), `page ${cap}`).toEqual({ user: 'user:u', relation: rel, object: 'page:p1' })
    }
  })

  it('maps SPACE capabilities to the DISTINCT model relations (viewer/editor/manager)', async () => {
    const cases: [Capability, string][] = [['view', 'viewer'], ['edit', 'editor'], ['manage', 'manager']]
    for (const [cap, rel] of cases) {
      const { client, calls } = fakeFga(true)
      await check(client, 'user:u', cap, { type: 'space', id: 's1' })
      expect(calls.at(-1), `space ${cap}`).toEqual({ user: 'user:u', relation: rel, object: 'space:s1' })
    }
  })

  it('THROWS for a capability with no relation on the type (space+comment) — never a silent allow', async () => {
    const { client, calls } = fakeFga(true)
    await expect(check(client, 'user:u', 'comment', { type: 'space', id: 's1' })).rejects.toThrow(/no FGA relation/)
    expect(calls).toHaveLength(0) // must reject BEFORE hitting FGA, not fall through to a wrong relation
  })

  it('returns the FGA verdict verbatim (true stays true, false stays false)', async () => {
    const yes = fakeFga(true)
    expect(await check(yes.client, 'user:u', 'view', { type: 'page', id: 'p1' })).toBe(true)
    const no = fakeFga(false)
    expect(await check(no.client, 'user:u', 'view', { type: 'page', id: 'p1' })).toBe(false)
  })
})

describe('checkMemberAccess — RW/RO/reject collapse (collab hot path)', () => {
  // Fake batchCheck returning per-relation verdicts, mirroring the real response shape.
  function fakeBatch(canEdit: boolean, canView: boolean) {
    return {
      batchCheck: async () => ({
        responses: [
          { _request: { relation: 'edit' }, allowed: canEdit },
          { _request: { relation: 'view' }, allowed: canView },
        ],
      }),
    } as unknown as OpenFgaClient
  }
  const page = { type: 'page' as const, id: 'p1' }

  it('canEdit -> { readOnly: false } (edit wins even if view also true)', async () => {
    expect(await checkMemberAccess(fakeBatch(true, true), 'u', page)).toEqual({ readOnly: false })
  })
  it('view only -> { readOnly: true }', async () => {
    expect(await checkMemberAccess(fakeBatch(false, true), 'u', page)).toEqual({ readOnly: true })
  })
  it('neither -> null (reject)', async () => {
    expect(await checkMemberAccess(fakeBatch(false, false), 'u', page)).toBeNull()
  })
})
