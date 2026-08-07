// #623 / ADR-220 §5: the tree's first paint — the root branch plus the path to the open page.
//
// Opening a page deep in a tree must not require walking down to it. No mechanism for this existed:
// there are ancestor CTEs for watches and for depth, but no "path to page" tree read.
//
// ⚠️ `open` is a HINT, never an argument. The sidebar knows the open page id, but the space it pairs it
// with comes from localStorage and can disagree until the page loads. So an unusable hint must NARROW
// the answer — the root branch alone — and never fail it: a hint that 404s is an oracle for page ids.
// Most of this file is that one property, from the three directions it can be wrong.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { TenantRegistry } from '../db/registry.js'
import { acquireTenantDb } from '../db/tenant-db.js'
import type { TenantDb } from '../db/index.js'
import { fgaClient } from '@wikistead/authz'
import { LogicalSearchDriver } from '../search/index.js'
import { createSpace, deleteSpace } from '../routes/spaces.js'
import { createPage, deletePage, paintTree } from '../routes/pages.js'
import type { Tenant } from '@wikistead/types'

const driver = new LogicalSearchDriver()
const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const STAMP = Date.now().toString(36)
const SUBJ = 'user:dev-user'

let tenant: Tenant, db: TenantDb
let space: string, other: string
let a: string, b: string, c: string, sibling: string, elsewhere: string, elsewhereChild: string

beforeAll(async () => {
  tenant = (await new TenantRegistry(pool).findBySlug('dev'))!
  db = await acquireTenantDb(tenant)
  space = (await createSpace(db, fgaClient, {
    tenantId: tenant.id, userId: 'dev-user', plan: tenant.plan, name: `pt623-${STAMP}`,
  })).id
  other = (await createSpace(db, fgaClient, {
    tenantId: tenant.id, userId: 'dev-user', plan: tenant.plan, name: `pt623-other-${STAMP}`,
  })).id
  const mk = async (sp: string, parent: string | null, title: string) => (await createPage(db, fgaClient, driver, {
    tenantId: tenant.id, spaceId: sp, userId: 'dev-user', title, parentId: parent,
  })).id
  a = await mk(space, null, `pt623-a-${STAMP}`)          // root
  b = await mk(space, a, `pt623-b-${STAMP}`)             // child
  c = await mk(space, b, `pt623-c-${STAMP}`)             // grandchild — the open page
  sibling = await mk(space, b, `pt623-sib-${STAMP}`)     // c's sibling, which the reader must see
  elsewhere = await mk(other, null, `pt623-elsewhere-${STAMP}`)
  // ⚠️ The cross-space page needs an ANCESTOR, or the "another space" case cannot fail: a root page has
  // no ancestors, so dropping the space predicate paints nothing either way. Measured that way first.
  elsewhereChild = await mk(other, elsewhere, `pt623-elsewhere-child-${STAMP}`)
}, 300_000)

afterAll(async () => {
  for (const id of [c, sibling, b, a, elsewhereChild, elsewhere]) {
    await deletePage(db, fgaClient, driver, { pageId: id, userId: 'dev-user' }).catch(() => {})
  }
  for (const sp of [space, other]) {
    await deleteSpace(db, fgaClient, driver, { tenantId: tenant.id, spaceId: sp, userId: 'dev-user' }).catch(() => {})
  }
  await db.release(); await pool.end({ timeout: 5 }); await admin.end()
}, 300_000)

const paint = (open?: string) =>
  paintTree(db, fgaClient, { spaceId: space, subject: SUBJ, ...(open ? { open } : {}) })

describe('#623 / ADR-220 §5: the first paint carries the path to the open page', () => {
  it('with no hint it is the root branch alone', async () => {
    const { branches } = await paint()
    expect(branches).toHaveLength(1)
    expect(branches[0]!.parentId).toBeNull()
    expect(branches[0]!.pages.map((p) => p.id)).toContain(a)
  }, 300_000)

  it('a deep open page paints every ancestor’s branch, outermost first', async () => {
    const { branches } = await paint(c)
    expect(branches.map((br) => br.parentId), 'root, then a, then b — the path down to the open page')
      .toEqual([null, a, b])
    // …and the open page's SIBLING is there, which is the reason the ancestor's branch is painted at
    // all rather than just the ancestor itself.
    const last = branches.at(-1)!
    expect(last.pages.map((p) => p.id)).toEqual(expect.arrayContaining([c, sibling]))
  }, 300_000)

  it('the open page’s own children are NOT painted', async () => {
    // It may be a leaf, and expanding it is a branch request like any other. Painting them would make
    // the first response grow with whatever the reader happens to have open.
    const { branches } = await paint(b)
    expect(branches.map((br) => br.parentId), 'stops at the open page, does not descend into it')
      .toEqual([null, a])
  }, 300_000)

  it('⚠️ a hint naming another space narrows the answer — it does not fail, and leaks no branch', async () => {
    // The hinted page has a PARENT in that other space. If the ancestor walk is not bound to this
    // space, that parent's branch is painted into this space's answer — pages from a space the reader
    // did not ask about, arriving through a hint they do not control.
    const { branches } = await paint(elsewhereChild)
    expect(branches, 'a page from another space must not widen or break the paint').toHaveLength(1)
    expect(branches[0]!.parentId).toBeNull()
    expect(branches.map((br) => br.parentId), 'a branch from the other space was painted')
      .not.toContain(elsewhere)
  }, 300_000)

  it('⚠️ a hint naming nothing at all narrows the answer too', async () => {
    const { branches } = await paint('pt623-no-such-page')
    expect(branches).toHaveLength(1)
    expect(branches[0]!.parentId).toBeNull()
  }, 300_000)

  it('the paint grows with DEPTH, not with the size of the space', async () => {
    // The property that makes this bounded: three ancestors means three branches, however many pages
    // the space holds. Compared against the same space's root branch count so the claim is measured
    // rather than restated.
    const deep = await paint(c)
    const shallow = await paint(a)
    expect(deep.branches.length - shallow.branches.length, 'each level of depth adds exactly one branch')
      .toBe(2)
  }, 300_000)
})
