// #1141 / ADR-220 §4.2 rev13: a placeholder walk whose budget runs out is now RESUMABLE — a call
// returns `placeholderCursor` alongside whatever it found, and a follow-up call presenting it picks
// the SAME walk up, examining what the first call never reached without re-examining (or re-reporting)
// anything it already settled. This file measures the guarantee itself, not the mechanism it wraps
// (`grantsPath`/`descendAll`'s own internal correctness is #623's business, unchanged by this ticket).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { TenantRegistry } from '../db/registry.js'
import { acquireTenantDb } from '../db/tenant-db.js'
import type { TenantDb } from '../db/index.js'
import { fgaClient, writeTuples, runInAuthzScope } from '@wikistead/authz'
import { LogicalSearchDriver } from '../search/index.js'
import { LogicalStorageDriver } from '../storage/index.js'
import { createSpace, deleteSpace } from '../routes/spaces.js'
import { createPage, deletePage, publishPage, setPagePrivate } from '../routes/pages.js'
import { resolveTreePlaceholders } from '../routes/tree-placeholders.js'
import { encodePlaceholderCursor, decodePlaceholderCursor, type PlaceholderCursorScope } from '../routes/tree-placeholders-cursor.js'
import { groupGrantee } from '../auth/group-sync.js'
import type { Tenant } from '@wikistead/types'

const driver = new LogicalSearchDriver()
const storage = new LogicalStorageDriver()
const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const STAMP = Date.now().toString(36)

let tenant: Tenant
let db: TenantDb
let spaceId: string
const made: string[] = []
const READER = `user:zz1141-reader-${STAMP}`
const GROUP = `zz1141-group-${STAMP}`

async function page(title: string, parentId: string | null, opts: { publish?: boolean } = {}): Promise<string> {
  const p = await createPage(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user', title, parentId })
  made.unshift(p.id)
  if (opts.publish !== false) {
    await publishPage(db, fgaClient, driver, storage, { pageId: p.id, subject: 'user:dev-user', createdBy: 'user:dev-user' })
  }
  return p.id
}

beforeAll(async () => {
  tenant = (await new TenantRegistry(pool).findBySlug('dev'))!
  db = await acquireTenantDb(tenant)
  const space = await createSpace(db, fgaClient, { tenantId: tenant.id, userId: 'dev-user', plan: tenant.plan, name: `ph1141-${STAMP}` })
  spaceId = space.id
  await writeTuples(fgaClient, [
    { user: READER, relation: 'member', object: `tenant:${tenant.id}` },
    { user: READER, relation: 'viewer', object: `space:${spaceId}` },
    // READER's real group membership — present in the FGA graph regardless of what `groups` is passed
    // to `resolveTreePlaceholders` below, so `descend`'s Check succeeds while `groups: []` keeps
    // grantsPath (path 1) structurally blind to it (the #623/#1119 precedent this file reuses).
    { user: READER, relation: 'member', object: `group:${groupGrantee(tenant.id, GROUP).slice('group:'.length).replace('#member', '')}` },
  ]).catch(() => {})
}, 300_000)

afterAll(async () => {
  for (const id of made) await deletePage(db, fgaClient, driver, { pageId: id, userId: 'dev-user' }).catch(() => {})
  await deleteSpace(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user' }).catch(() => {})
  await db.release()
  await pool.end({ timeout: 5 })
  await admin.end()
}, 300_000)

describe('#1141: path 2 (descend) is resumable — no page examined or reported twice across calls', () => {
  it('a second call presenting the first call\'s cursor reaches the remaining chains, with zero overlap', async () => {
    // Four SEPARATE invisible (draft) parents at the root, each hiding one child granted to READER's
    // GROUP only — isolates path 2, same technique the existing GROUP-grant pin above uses.
    const seeds: string[] = []
    const children: string[] = []
    for (let i = 0; i < 4; i++) {
      const parent = await page(`ph1141-p${i}-${STAMP}`, null, { publish: false })
      const child = await page(`ph1141-c${i}-${STAMP}`, parent)
      await writeTuples(fgaClient, [{ user: groupGrantee(tenant.id, GROUP), relation: 'view_direct', object: `page:${child}` }])
      seeds.push(parent)
      children.push(child)
    }

    // Budget of 2: `descendAll` charges 1 unit per node EXAMINED (the parent) plus 1 per row
    // view-Checked — so 2 units can examine at most one parent-and-its-one-child pair before the
    // budget is spent, not all four.
    const call1 = await resolveTreePlaceholders(db, fgaClient, {
      spaceId, tenantId: tenant.id, branchParentId: null, subject: READER, groups: [],
      invisibleChildIds: seeds, toPage: (row) => ({ id: row.id as string }),
      budget: { left: 2 },
    })
    expect(call1.placeholderCursor, 'a budget of 2 cannot have finished all four chains').toBeTruthy()
    const foundInCall1 = new Set(call1.placeholders.flatMap((n) => n.pages.map((p) => p.id as string)))
    expect(foundInCall1.size, 'call 1 found some, but not all four').toBeGreaterThan(0)
    expect(foundInCall1.size).toBeLessThan(4)

    const call2 = await resolveTreePlaceholders(db, fgaClient, {
      spaceId, tenantId: tenant.id, branchParentId: null, subject: READER, groups: [],
      invisibleChildIds: seeds, toPage: (row) => ({ id: row.id as string }),
      budget: { left: 200 }, cursor: call1.placeholderCursor,
    })
    const foundInCall2 = new Set(call2.placeholders.flatMap((n) => n.pages.map((p) => p.id as string)))

    for (const id of foundInCall1) {
      expect(foundInCall2.has(id), `call 2 must not re-report ${id} — call 1 already did`).toBe(false)
    }
    const union = new Set([...foundInCall1, ...foundInCall2])
    for (const c of children) expect(union.has(c), `${c} must be found by one of the two calls`).toBe(true)
    expect(call2.placeholderCursor, 'the whole closure fit in call 2\'s generous budget').toBeUndefined()
  }, 300_000)
})

describe('#1141: path 1 (grantsPath) is resumable too, and still runs before path 2 on a resumed call', () => {
  it('a candidate list split across two calls is resolved exactly once each, and path 2 waits for it', async () => {
    // A root-level invisible page, granted DIRECTLY (path 1's own territory — grantsPath's roster
    // read finds the `view_direct` tuple the candidate loop below resolves), PLUS a SEPARATE
    // path-2-only seed (draft parent, group-granted child) that must not be touched until path 1 is
    // completely done, even across the resume boundary. `nearestVisible` for `grantedChild`'s chain
    // must equal `branchParentId` (null, the root) for grantsPath to place it here at all (§4.2) — so
    // `b0` sits directly at the root, not under a further collapsed ancestor.
    // TWO root-level invisible pages, each granted DIRECTLY — grantsPath's candidate-resolution loop
    // (not just its roster read) must split across the resume boundary without resolving either one
    // twice, which needs at least two candidates to be sensitive to at all.
    const b0 = await page(`ph1141-anc-mid-${STAMP}`, null)
    const grantedChild = await page(`ph1141-anc-child-${STAMP}`, b0)
    const b1 = await page(`ph1141-anc-mid2-${STAMP}`, null)
    const grantedChild2 = await page(`ph1141-anc-child2-${STAMP}`, b1)
    // Both must be genuinely INVISIBLE (§4.0) for #1093's own guard to even attempt path 1 here —
    // `page()` publishes by default, so each starts out visible to every space member; make them
    // PRIVATE (the marker cascades) and grant each CHILD its own direct tuple to stay visible past
    // it, the same shape #623's own private-parent pin uses.
    await setPagePrivate(db, fgaClient, driver, { pageId: b0, tenantId: tenant.id, userId: 'dev-user' })
    await setPagePrivate(db, fgaClient, driver, { pageId: b1, tenantId: tenant.id, userId: 'dev-user' })
    await writeTuples(fgaClient, [
      { user: READER, relation: 'view_direct', object: `page:${grantedChild}` },
      { user: READER, relation: 'view_direct', object: `page:${grantedChild2}` },
    ])

    const path2Parent = await page(`ph1141-p2-${STAMP}`, null, { publish: false })
    const path2Child = await page(`ph1141-p2-child-${STAMP}`, path2Parent)
    await writeTuples(fgaClient, [{ user: groupGrantee(tenant.id, GROUP), relation: 'view_direct', object: `page:${path2Child}` }])

    // Budget tight enough to finish the roster read (both tuples fit one FGA page) and resolve ONE
    // candidate's chain (1 unit to query it, 2 more for `viewChecked` on its 2-row ancestor chain —
    // see `resolveCandidates`), but not the second — forcing the FIRST call to stop mid path-1,
    // before path 2's seed is even looked at.
    const call1 = await resolveTreePlaceholders(db, fgaClient, {
      spaceId, tenantId: tenant.id, branchParentId: null, subject: READER, groups: [],
      invisibleChildIds: [path2Parent], toPage: (row) => ({ id: row.id as string }),
      budget: { left: 4 },
    })
    expect(call1.placeholderCursor, 'budget 4 cannot have finished both candidates, let alone reached path 2').toBeTruthy()
    const call1Found = new Set(call1.placeholders.flatMap((n) => n.pages.map((p) => p.id as string)))
    expect(call1Found.size, 'call 1 resolved exactly one of the two candidates').toBe(1)
    expect(call1Found.has(path2Child), 'path 2 must not have been touched while path 1 is still pending').toBe(false)

    const call2 = await resolveTreePlaceholders(db, fgaClient, {
      spaceId, tenantId: tenant.id, branchParentId: null, subject: READER, groups: [],
      invisibleChildIds: [path2Parent], toPage: (row) => ({ id: row.id as string }),
      budget: { left: 200 }, cursor: call1.placeholderCursor,
    })
    const call2Found = new Set(call2.placeholders.flatMap((n) => n.pages.map((p) => p.id as string)))
    for (const id of call1Found) {
      expect(call2Found.has(id), `call 2 must not re-resolve ${id} — call 1 already did`).toBe(false)
    }
    const union = new Set([...call1Found, ...call2Found])
    expect(union.has(grantedChild) && union.has(grantedChild2), 'both path-1 candidates are resolved, across the two calls').toBe(true)
    expect(call2Found.has(path2Child), 'path 2 finally runs once path 1 finishes, in the resumed call').toBe(true)
  }, 300_000)
})

describe('#1141: the continuation cursor is opaque, tamper-evident and scope-bound', () => {
  const scope = (over: Partial<PlaceholderCursorScope> = {}): PlaceholderCursorScope => ({
    tenantId: 'zz1141-tenant', subject: 'user:zz1141-subject', spaceId: 'zz1141-space', branchParentId: null, ...over,
  })

  it('a well-formed cursor round-trips under its own scope', () => {
    const s = scope()
    const token = encodePlaceholderCursor({ hello: 'world' }, s)
    expect(decodePlaceholderCursor<{ hello: string }>(token, s)).toEqual({ hello: 'world' })
  })

  it('a cursor minted for one subject is refused under another (restarts, does not leak or throw)', () => {
    const token = encodePlaceholderCursor({ hello: 'world' }, scope())
    expect(decodePlaceholderCursor(token, scope({ subject: 'user:someone-else' }))).toBeUndefined()
  })

  it('a cursor minted for one branch is refused under another', () => {
    const token = encodePlaceholderCursor({ hello: 'world' }, scope())
    expect(decodePlaceholderCursor(token, scope({ branchParentId: 'some-other-page' }))).toBeUndefined()
  })

  it('a bit-flipped body fails the MAC and restarts rather than decoding garbage', () => {
    const s = scope()
    const token = encodePlaceholderCursor({ hello: 'world' }, s)
    const [body, mac] = token.split('.')
    const flipped = `${body!.slice(0, -1)}${body!.at(-1) === 'A' ? 'B' : 'A'}.${mac}`
    expect(decodePlaceholderCursor(flipped, s)).toBeUndefined()
  })

  it('garbage, empty, and undefined cursors all restart safely rather than throwing', () => {
    const s = scope()
    expect(decodePlaceholderCursor(undefined, s)).toBeUndefined()
    expect(decodePlaceholderCursor('', s)).toBeUndefined()
    expect(decodePlaceholderCursor('not-a-real-cursor-at-all', s)).toBeUndefined()
    expect(decodePlaceholderCursor('.', s)).toBeUndefined()
  })

  it('an absent/tampered cursor makes resolveTreePlaceholders restart the WHOLE walk, not throw or 500', async () => {
    const parent = await page(`ph1141-restart-p-${STAMP}`, null, { publish: false })
    const child = await page(`ph1141-restart-c-${STAMP}`, parent)
    await writeTuples(fgaClient, [{ user: groupGrantee(tenant.id, GROUP), relation: 'view_direct', object: `page:${child}` }])

    const result = await resolveTreePlaceholders(db, fgaClient, {
      spaceId, tenantId: tenant.id, branchParentId: null, subject: READER, groups: [],
      invisibleChildIds: [parent], toPage: (row) => ({ id: row.id as string }),
      budget: { left: 200 }, cursor: 'garbage-not-a-cursor',
    })
    const found = new Set(result.placeholders.flatMap((n) => n.pages.map((p) => p.id as string)))
    expect(found.has(child), 'a bad cursor restarts the walk from the top instead of refusing to run').toBe(true)
  }, 300_000)
})

describe('#1141: §4.4\'s restricted-scope refusal still applies on a resumed call', () => {
  it('a confined scope refuses to resolve — even on the SECOND call, with a real cursor in hand', async () => {
    const parent = await page(`ph1141-scope-p-${STAMP}`, null, { publish: false })
    const child = await page(`ph1141-scope-c-${STAMP}`, parent)
    await writeTuples(fgaClient, [{ user: groupGrantee(tenant.id, GROUP), relation: 'view_direct', object: `page:${child}` }])

    // Mint a REAL cursor first, unrestricted (exactly what a genuine multi-call sequence produces).
    const call1 = await resolveTreePlaceholders(db, fgaClient, {
      spaceId, tenantId: tenant.id, branchParentId: null, subject: READER, groups: [],
      invisibleChildIds: [parent], toPage: (row) => ({ id: row.id as string }),
      budget: { left: 1 }, // just enough to examine the parent node itself, not resolve its child
    })
    expect(call1.placeholderCursor, 'budget 1 must not have finished this chain').toBeTruthy()

    // Resume the SAME cursor, but this time inside a confined scope (ADR-216 / #637's own shape) that
    // does not include this space — §4.4 must refuse regardless of the cursor being genuine and valid.
    // rev13 (design-review B2): budget deliberately kept TIGHT (matching call1's own budget of 1, which
    // this fixture's other assertion already proves is not enough to finish the chain) rather than
    // generous — a generous budget here made this test PASS even with the §4.4 guard deleted entirely
    // (the unguarded call would have finished the whole chain and legitimately returned no cursor,
    // indistinguishable from a correct refusal). A tight budget makes an unguarded resumed call finish
    // NEITHER the chain NOR without a cursor, so `placeholderCursor` staying undefined is proof the
    // refusal fired, not a coincidence of the budget being generous enough to complete anyway.
    const restricted = await runInAuthzScope({ restriction: { spaces: new Set(['some-other-space']) } }, () =>
      resolveTreePlaceholders(db, fgaClient, {
        spaceId, tenantId: tenant.id, branchParentId: null, subject: READER, groups: [],
        invisibleChildIds: [parent], toPage: (row) => ({ id: row.id as string }),
        budget: { left: 1 }, cursor: call1.placeholderCursor,
      }));
    expect(restricted.placeholders, 'a confined scope gets nothing, cursor or not').toEqual([]);
    expect(restricted.placeholderCursor, 'a refused call has nothing left to resume either').toBeUndefined();

    // Sanity: the SAME resumed call, unrestricted, DOES find the child — proving the refusal above is
    // the scope check firing, not an unrelated reason (an expired cursor, an empty frontier, etc).
    const unrestricted = await resolveTreePlaceholders(db, fgaClient, {
      spaceId, tenantId: tenant.id, branchParentId: null, subject: READER, groups: [],
      invisibleChildIds: [parent], toPage: (row) => ({ id: row.id as string }),
      budget: { left: 200 }, cursor: call1.placeholderCursor,
    })
    const found = new Set(unrestricted.placeholders.flatMap((n) => n.pages.map((p) => p.id as string)))
    expect(found.has(child), 'sanity: the same resumed call, unrestricted, finds the child').toBe(true)
  }, 300_000)
})
