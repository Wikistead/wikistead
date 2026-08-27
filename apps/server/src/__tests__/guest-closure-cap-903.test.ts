// #903 / ADR-220 §13: the guest whole-space read no longer runs a `view` Check (and a badge read) on
// every page in the space to show `GUEST_TREE_CAP` rows — `listPagesGuestBounded` walks the tree
// closure in DFS pre-order, one branch at a time, and stops confirming once it has enough VISIBLE
// pages. Building a fixture past the shipped cap (500) would cost minutes (see #623's own note), so
// these pins call the exported function directly with a small `cap` override — the SAME code path the
// route runs, exercised against a fixture cheap enough for every commit.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { TenantRegistry } from '../db/registry.js'
import { acquireTenantDb } from '../db/tenant-db.js'
import type { TenantDb } from '../db/index.js'
import { fgaClient, writeTuples, deleteTuples } from '@wikistead/authz'
import { LogicalSearchDriver } from '../search/index.js'
import { createSpace, deleteSpace } from '../routes/spaces.js'
import { createPage, listPagesGuestBounded } from '../routes/pages.js'
import type { Tenant } from '@wikistead/types'

const driver = new LogicalSearchDriver()
const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const STAMP = Date.now().toString(36)
const LINK = `gcc903-${STAMP}`

let tenant: Tenant, db: TenantDb
let space: string
const ids: Record<string, string> = {}

async function makePage(title: string, parentId: string | null, visible: boolean) {
  const id = (await createPage(db, fgaClient, driver, {
    tenantId: tenant.id, spaceId: space, userId: 'dev-user', title, parentId,
  })).id
  await admin`UPDATE pages SET published_md = 'b', published_at = now() WHERE id = ${id}`
  if (visible) {
    await writeTuples(fgaClient, [{ user: `space:${space}`, relation: 'space', object: `page:${id}` }])
  }
  ids[title] = id
  return id
}

beforeAll(async () => {
  tenant = (await new TenantRegistry(pool).findBySlug('dev'))!
  db = await acquireTenantDb(tenant)
  space = (await createSpace(db, fgaClient, {
    tenantId: tenant.id, userId: 'dev-user', plan: tenant.plan, name: `gcc903-${STAMP}`,
  })).id
  await writeTuples(fgaClient, [{ user: `share_link:${LINK}`, relation: 'viewer', object: `space:${space}` }])

  // Tree shape (DFS pre-order): root1, root1-child1, root1-child2, root2(invisible child C), root3
  const root1 = await makePage('root1', null, true)
  await makePage('root1-child1', root1, true)
  await makePage('root1-child2', root1, true)
  const root2 = await makePage('root2', null, true)
  await makePage('root2-child-invisible', root2, false) // NOT granted `space` — invisible to the guest
  await makePage('root3', null, true)
}, 300_000)

afterAll(async () => {
  await deleteTuples(fgaClient, [{ user: `share_link:${LINK}`, relation: 'viewer', object: `space:${space}` }]).catch(() => {})
  await admin`DELETE FROM pages WHERE space_id = ${space}`.catch(() => {})
  await deleteSpace(db, fgaClient, driver, { tenantId: tenant.id, spaceId: space, userId: 'dev-user' }).catch(() => {})
  await db.release(); await pool.end({ timeout: 5 }); await admin.end()
}, 300_000)

const subject = `share_link:${LINK}`
const ctx = { current_time: new Date().toISOString() }

describe('#903 / ADR-220 §13: closure-bounded guest tree', () => {
  it('under cap: every visible page returned, none truncated', async () => {
    const out = await listPagesGuestBounded(db, fgaClient, { spaceId: space, subject, context: ctx, cap: 50 })
    expect(out.truncated).toBe(false)
    expect(out.pages.map((p) => p.title)).toEqual(['root1', 'root1-child1', 'root1-child2', 'root2', 'root3'])
  })

  it('DFS pre-order: a root\'s whole subtree precedes the next root — not flat position order', async () => {
    const out = await listPagesGuestBounded(db, fgaClient, { spaceId: space, subject, context: ctx, cap: 50 })
    const order = out.pages.map((p) => p.title)
    expect(order.indexOf('root1-child2'), 'root1 subtree finishes before root2 starts')
      .toBeLessThan(order.indexOf('root2'))
  })

  it('an invisible child never appears and does not consume closure budget', async () => {
    const out = await listPagesGuestBounded(db, fgaClient, { spaceId: space, subject, context: ctx, cap: 50 })
    expect(out.pages.some((p) => p.title === 'root2-child-invisible')).toBe(false)
    // 5 visible pages total (root1 + 2 children, root2, root3) — the invisible child is not among them
    // and did not eat a slot that would otherwise have shown root3.
    expect(out.pages).toHaveLength(5)
  })

  it('exactly at the cap: NOT truncated (a flat length compare would get this wrong)', async () => {
    const out = await listPagesGuestBounded(db, fgaClient, { spaceId: space, subject, context: ctx, cap: 5 })
    expect(out.pages).toHaveLength(5)
    expect(out.truncated, 'nothing past the 5th visible page exists — this is not a cut').toBe(false)
  })

  it('one past the cap: truncated, and the ancestor-inclusion invariant holds', async () => {
    const out = await listPagesGuestBounded(db, fgaClient, { spaceId: space, subject, context: ctx, cap: 3 })
    expect(out.truncated).toBe(true)
    expect(out.pages.map((p) => p.title)).toEqual(['root1', 'root1-child1', 'root1-child2'])
    const byId = new Map(out.pages.map((p) => [p.id, p]))
    for (const p of out.pages) {
      if (p.parentId != null) expect(byId.has(p.parentId), `${p.title}'s parent is in the same response`).toBe(true)
    }
  })

  it('truncation mid-subtree still emits the ancestors that were already found', async () => {
    // cap=1 stops right after root1 itself — root1's children never get pushed, so the closure never
    // claims to have shown a page without its parent.
    const out = await listPagesGuestBounded(db, fgaClient, { spaceId: space, subject, context: ctx, cap: 1 })
    expect(out.truncated).toBe(true)
    expect(out.pages.map((p) => p.title)).toEqual(['root1'])
  })
})
