// #1141 / ADR-220 §6.2 rev12: the guest whole-space closure walk (`listPagesGuestBounded`, #903)
// gets the SAME resumability the member-side placeholder walk got — hitting `GUEST_TREE_CAP` (or
// `placeholderBudget`) now returns `nextCursor`, and a follow-up call presenting it picks the SAME
// closure walk up where it stopped, never re-examining or re-reporting a page the first call already
// settled. This mirrors `tree-placeholders-resumable-1141.test.ts` for the guest path specifically —
// `listBranch`/`resolveGuestPlaceholders`'s own correctness is #903's business, unchanged here.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { TenantRegistry } from '../db/registry.js'
import { acquireTenantDb } from '../db/tenant-db.js'
import type { TenantDb } from '../db/index.js'
import { fgaClient, writeTuples, deleteTuples } from '@wikistead/authz'
import { LogicalSearchDriver } from '../search/index.js'
import { createSpace, deleteSpace } from '../routes/spaces.js'
import { createPage, deletePage, listPagesGuestBounded } from '../routes/pages.js'
import type { Tenant } from '@wikistead/types'

const driver = new LogicalSearchDriver()
const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const STAMP = Date.now().toString(36)
const LINK = `gtr1141-${STAMP}`

let tenant: Tenant
let db: TenantDb
let spaceId: string
const made: string[] = []
const subject = `share_link:${LINK}`
const ctx = { current_time: new Date().toISOString() }

async function visiblePage(title: string, parentId: string | null): Promise<string> {
  const p = await createPage(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user', title, parentId })
  made.unshift(p.id)
  await admin`UPDATE pages SET published_md = 'b', published_at = now() WHERE id = ${p.id}`
  await writeTuples(fgaClient, [{ user: `space:${spaceId}`, relation: 'space', object: `page:${p.id}` }])
  return p.id
}

// A page nobody granted `space` to (never published-and-shared) — invisible to the guest, so a
// placeholder anchor is what stands in for it (ADR-220 §14).
async function invisiblePage(title: string, parentId: string | null): Promise<string> {
  const p = await createPage(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user', title, parentId })
  made.unshift(p.id)
  await admin`UPDATE pages SET published_md = 'b', published_at = now() WHERE id = ${p.id}`
  return p.id
}

beforeAll(async () => {
  tenant = (await new TenantRegistry(pool).findBySlug('dev'))!
  db = await acquireTenantDb(tenant)
  const space = await createSpace(db, fgaClient, { tenantId: tenant.id, userId: 'dev-user', plan: tenant.plan, name: `gtr1141-${STAMP}` })
  spaceId = space.id
  await writeTuples(fgaClient, [{ user: subject, relation: 'viewer', object: `space:${spaceId}` }])
}, 300_000)

afterAll(async () => {
  for (const id of made) await deletePage(db, fgaClient, driver, { pageId: id, userId: 'dev-user' }).catch(() => {})
  await deleteSpace(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user' }).catch(() => {})
  await db.release()
  await pool.end({ timeout: 5 })
  await admin.end()
}, 300_000)

describe('#1141: the guest closure walk (children path) is resumable — no page examined or reported twice', () => {
  it('a second call presenting the first call\'s cursor reaches the remaining root pages, with zero overlap', async () => {
    const roots: string[] = []
    for (let i = 0; i < 5; i++) roots.push(await visiblePage(`gtr1141-root${i}-${STAMP}`, null))

    const call1 = await listPagesGuestBounded(db, fgaClient, { spaceId, tenantId: tenant.id, subject, context: ctx, cap: 2 })
    expect(call1.truncated, 'cap 2 of 5 roots must truncate').toBe(true)
    expect(call1.nextCursor, 'a truncated call must hand back a cursor').toBeTruthy()
    expect(call1.pages).toHaveLength(2)
    const foundInCall1 = new Set(call1.pages.map((p) => p.id))

    const call2 = await listPagesGuestBounded(db, fgaClient, {
      spaceId, tenantId: tenant.id, subject, context: ctx, cap: 50, cursor: call1.nextCursor,
    })
    const foundInCall2 = new Set(call2.pages.map((p) => p.id))
    for (const id of foundInCall1) {
      expect(foundInCall2.has(id), `call 2 must not re-report ${id} — call 1 already did`).toBe(false)
    }
    const union = new Set([...foundInCall1, ...foundInCall2])
    for (const r of roots) expect(union.has(r), `${r} must be found by one of the two calls`).toBe(true)
    expect(union.size, 'the union has exactly the 5 roots, no duplicates').toBe(5)
    expect(call2.truncated, 'the remainder fit in call 2\'s generous cap').toBe(false)
    expect(call2.nextCursor).toBeUndefined()
  }, 300_000)
})

describe('#1141: the guest placeholder-anchor resolution also resumes, independent of the children cap', () => {
  it('a placeholder budget split across two calls resolves each anchor exactly once, in the right order', async () => {
    // Two SEPARATE invisible root parents, each hiding one child granted DIRECTLY to the share_link
    // (§14's own anchor mechanism) — a generous `cap` (children budget) but a tight `placeholderBudget`
    // forces the split to land specifically inside `resolveGuestPlaceholders`'s own frontier, not the
    // children-reading loop above it.
    const p0 = await invisiblePage(`gtr1141-anc0-${STAMP}`, null)
    const c0 = await invisiblePage(`gtr1141-anc0-child-${STAMP}`, p0)
    const p1 = await invisiblePage(`gtr1141-anc1-${STAMP}`, null)
    const c1 = await invisiblePage(`gtr1141-anc1-child-${STAMP}`, p1)
    await writeTuples(fgaClient, [
      { user: subject, relation: 'view_direct', object: `page:${c0}` },
      { user: subject, relation: 'view_direct', object: `page:${c1}` },
    ])

    // `descendAll`'s own per-node accounting (1 unit examined + N units view-Checked) means a budget of
    // 2 can examine at most one anchor's own parent-and-child pair before running out — matching the
    // member-path pin above.
    const call1 = await listPagesGuestBounded(db, fgaClient, {
      spaceId, tenantId: tenant.id, subject, context: ctx, cap: 50, placeholderBudget: 2,
    })
    expect(call1.truncated, 'a spent placeholder budget must be reported as a stop, not silently finished').toBe(true)
    expect(call1.nextCursor).toBeTruthy()
    // The anchors' own hidden children live nested in `placeholders[].pages` (ADR-220 §14), not in the
    // top-level `pages` array — that one only ever holds directly-visible pages found via `listBranch`.
    const foundInCall1 = new Set(call1.placeholders.flatMap((n) => n.pages.map((p) => p.id as string)))
    expect(foundInCall1.size, 'call 1 resolved exactly one of the two anchors').toBe(1)

    const call2 = await listPagesGuestBounded(db, fgaClient, {
      spaceId, tenantId: tenant.id, subject, context: ctx, cap: 50, placeholderBudget: 200, cursor: call1.nextCursor,
    })
    const foundInCall2 = new Set(call2.placeholders.flatMap((n) => n.pages.map((p) => p.id as string)))
    for (const id of foundInCall1) {
      expect(foundInCall2.has(id), `call 2 must not re-resolve ${id} — call 1 already did`).toBe(false)
    }
    const union = new Set([...foundInCall1, ...foundInCall2])
    expect(union.has(c0) && union.has(c1), 'both anchors\' children are resolved, across the two calls').toBe(true)
    expect(call2.truncated).toBe(false)
  }, 300_000)
})

describe('#1141 rev12 (design-review B3): a resumed reveal re-confirms visibility, not just re-fetches the row', () => {
  it('a page that lost its grant BETWEEN the two calls is dropped from the resumed response, not replayed stale', async () => {
    // A DEDICATED space (not the file's shared one) — this test needs to control root-level DFS order
    // exactly (cap:1 must stop right after the FIRST page), which the shared space's own leftover
    // fixtures from the describes above would make unpredictable.
    const link2 = `${LINK}-b3`
    const subject2 = `share_link:${link2}`
    const space2 = await createSpace(db, fgaClient, { tenantId: tenant.id, userId: 'dev-user', plan: tenant.plan, name: `gtr1141-b3-${STAMP}` })
    await writeTuples(fgaClient, [{ user: subject2, relation: 'viewer', object: `space:${space2.id}` }])
    const mk = async (title: string) => {
      const p = await createPage(db, fgaClient, driver, { tenantId: tenant.id, spaceId: space2.id, userId: 'dev-user', title, parentId: null })
      made.unshift(p.id)
      await admin`UPDATE pages SET published_md = 'b', published_at = now() WHERE id = ${p.id}`
      await writeTuples(fgaClient, [{ user: `space:${space2.id}`, relation: 'space', object: `page:${p.id}` }])
      return p.id
    }
    try {
      const a = await mk(`gtr1141-stale-a-${STAMP}`)
      const b = await mk(`gtr1141-stale-b-${STAMP}`)
      const c = await mk(`gtr1141-stale-c-${STAMP}`)

      // cap:1 stops right after revealing `a`, leaving `b` sitting as a PENDING 'reveal' item in the
      // cursor — discovered (its id is known) but not yet re-confirmed visible.
      const call1 = await listPagesGuestBounded(db, fgaClient, { spaceId: space2.id, tenantId: tenant.id, subject: subject2, context: ctx, cap: 1 })
      expect(call1.pages.map((p) => p.id)).toEqual([a])
      expect(call1.nextCursor).toBeTruthy()

      // Between the two calls, `b`'s grant is revoked (unpublish/un-share) — exactly the window
      // "re-confirm visibility right before display, not just at discovery time" exists to close, now
      // that a resumed call can straddle it.
      //
      // rev12 (design-review N2): without the `revealPage` recheck, this does NOT go red on the
      // disclosure assertion below — `b`'s promoted-to-'children' item hits `listBranch`'s own §2
      // uniform-404 gate on ITS parent-view check first, so the walk THROWS (see the mutated-code repro
      // in the ticket's design review) rather than silently returning `b`. This test is still a genuine,
      // non-vacuous break-check (removing the recheck makes `listPagesGuestBounded` crash instead of
      // completing), but the failure mode it actually exercises is "does not 500 on a mid-walk
      // revocation", not "the revoked page's content is invisible" — the latter is true of the shipped
      // code but this specific pin cannot distinguish it from the former.
      await deleteTuples(fgaClient, [{ user: `space:${space2.id}`, relation: 'space', object: `page:${b}` }])

      const call2 = await listPagesGuestBounded(db, fgaClient, { spaceId: space2.id, tenantId: tenant.id, subject: subject2, context: ctx, cap: 50, cursor: call1.nextCursor })
      const ids = new Set(call2.pages.map((p) => p.id))
      expect(ids.has(b), 'a page whose grant was revoked mid-walk must not be replayed from a stale cursor').toBe(false)
      expect(ids.has(c), 'a page that stayed visible is unaffected by the drop').toBe(true)
    } finally {
      await deleteSpace(db, fgaClient, driver, { tenantId: tenant.id, spaceId: space2.id, userId: 'dev-user' }).catch(() => {})
    }
  }, 300_000)
})

describe('#1141: an absent/tampered guest cursor restarts the WHOLE closure walk, not a 500 or a silent gap', () => {
  it('a garbage cursor is treated exactly like no cursor at all', async () => {
    const solo = await visiblePage(`gtr1141-restart-${STAMP}`, null)

    const result = await listPagesGuestBounded(db, fgaClient, {
      spaceId, tenantId: tenant.id, subject, context: ctx, cap: 50, cursor: 'garbage-not-a-real-cursor',
    })
    expect(result.pages.some((p) => p.id === solo), 'a bad cursor restarts from the top instead of refusing to run').toBe(true)
  }, 300_000)
})
