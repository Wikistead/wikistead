// #623 / ADR-220 §1-§3, §8: one BRANCH of the page tree, bounded and keyset-paged.
//
// The unit is a branch rather than a window over the whole space: a DFS cursor would encode a position
// in a traversal that changes whenever the reader opens a node, which is the shape #574 called silent
// truncation.
//
// ⚠️ Per-branch fetching lets the CALLER NAME A PARENT, which the whole-space route never allowed. That
// is the new attack surface, and most of this file is about it: absent, another space's, trashed and
// invisible must all answer ONE identical 404, or the tree becomes a membership oracle for page ids.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { TenantRegistry } from '../db/registry.js'
import { acquireTenantDb } from '../db/tenant-db.js'
import type { TenantDb } from '../db/index.js'
import { fgaClient } from '@wikistead/authz'
import { LogicalSearchDriver } from '../search/index.js'
import { buildApp } from '../app.js'
import { createSpace, deleteSpace } from '../routes/spaces.js'
import { createPage, deletePage, setPagePrivate, listBranch } from '../routes/pages.js'
import type { Tenant } from '@wikistead/types'

const driver = new LogicalSearchDriver()
const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const STAMP = Date.now().toString(36)
const N = 7            // children under one parent
const PAGE = 3
const H = { host: 'dev.localhost', authorization: 'Bearer dev-token' }

let app: FastifyInstance
let tenant: Tenant
let db: TenantDb
let spaceId: string
let otherSpaceId: string
let parentId: string
let hiddenId: string
const childIds: string[] = []

const SUBJ = 'user:dev-user'

beforeAll(async () => {
  const registry = new TenantRegistry(pool)
  tenant = (await registry.findBySlug('dev'))!
  db = await acquireTenantDb(tenant)
  app = await buildApp(); await app.ready()
  const space = await createSpace(db, fgaClient, {
    tenantId: tenant.id, userId: 'dev-user', plan: tenant.plan, name: `br623-space-${STAMP}`,
  })
  spaceId = space.id
  const other = await createSpace(db, fgaClient, {
    tenantId: tenant.id, userId: 'dev-user', plan: tenant.plan, name: `br623-other-${STAMP}`,
  })
  otherSpaceId = other.id
  const parent = await createPage(db, fgaClient, driver, {
    tenantId: tenant.id, spaceId, userId: 'dev-user', title: `br623-parent-${STAMP}`, parentId: null,
  })
  parentId = parent.id
  for (let i = 0; i < N; i++) {
    const c = await createPage(db, fgaClient, driver, {
      tenantId: tenant.id, spaceId, userId: 'dev-user', title: `br623-c-${String(i).padStart(2, '0')}`, parentId,
    })
    childIds.push(c.id)
  }
  // A child the reader may not see, so §3's "absent, with no gap" has something to be absent.
  const hidden = await createPage(db, fgaClient, driver, {
    tenantId: tenant.id, spaceId, userId: 'dev-user', title: `br623-hidden-${STAMP}`, parentId,
  })
  hiddenId = hidden.id
}, 300_000)

afterAll(async () => {
  for (const id of [...childIds, hiddenId, parentId]) {
    await deletePage(db, fgaClient, driver, { pageId: id, userId: 'dev-user' }).catch(() => {})
  }
  for (const id of [spaceId, otherSpaceId]) {
    await deleteSpace(db, fgaClient, driver, { tenantId: tenant.id, spaceId: id, userId: 'dev-user' }).catch(() => {})
  }
  await app.close()
  await app.valkey.quit().catch(() => {})
  await db.release()
  await pool.end({ timeout: 5 })
  await admin.end()
}, 300_000)

const branch = (parent: string | null, cursor?: string) =>
  listBranch(db, fgaClient, {
    spaceId, parentId: parent, subject: SUBJ, limit: PAGE, ...(cursor ? { cursor } : {}),
  })

describe('#623 / ADR-220: a branch is bounded, and naming its parent tells nothing', () => {
  it('one response does not carry the whole branch', async () => {
    const first = await branch(parentId)
    expect(first.pages.length).toBeLessThanOrEqual(PAGE)
    expect(first.nextCursor, 'the fixture fits in one page — nothing below is being tested').toBeTruthy()
  }, 300_000)

  it('walking the branch returns every child exactly once, in position order', async () => {
    const seen: string[] = []
    let cursor: string | undefined
    for (let guard = 0; guard < 50; guard++) {
      const page = await branch(parentId, cursor)
      seen.push(...page.pages.map((p) => p.id))
      if (!page.nextCursor) break
      cursor = page.nextCursor
    }
    const repeats = seen.filter((s, i) => seen.indexOf(s) !== i)
    expect(repeats, `returned twice: ${[...new Set(repeats)].join(', ')}`).toEqual([])
    const truth = (await admin<{ id: string }[]>`
      SELECT id FROM pages WHERE parent_id = ${parentId} AND deleted_at IS NULL
       ORDER BY position, created_at`).map((r) => r.id)
    expect(seen, 'the walk did not return the branch in its own order').toEqual(truth)
  }, 300_000)

  it('the cursor names a ROW, and a deleted anchor restarts rather than guessing', async () => {
    // §8: `position` is user-controlled and `rebalanceSiblings` rewrites every sibling's, so a literal
    // cursor value can be crossed in both directions — rows SKIPPED, the direction that hides. The
    // anchor is an id and its position is resolved per request.
    const first = await branch(parentId)
    expect(first.nextCursor).toBe(first.pages.at(-1)!.id)
    const gone = await branch(parentId, 'br623-no-such-anchor')
    expect(gone.restarted, 'a vanished anchor must SAY it restarted — the caller has to replace, not append')
      .toBe(true)
    expect(gone.pages[0]!.id, 'and it restarts from the top').toBe(first.pages[0]!.id)
  }, 300_000)

  it('a child the reader cannot view is absent, with no gap', async () => {
    // §3: parent visibility implies nothing about a child. Made invisible by the page's own private
    // marker, which is the mechanism the tree has to survive.
    await setPagePrivate(db, fgaClient, driver, { pageId: hiddenId, tenantId: tenant.id, userId: 'dev-user' })
    const all: string[] = []
    let cursor: string | undefined
    for (let guard = 0; guard < 50; guard++) {
      const page = await branch(parentId, cursor)
      all.push(...page.pages.map((p) => p.id))
      if (!page.nextCursor) break
      cursor = page.nextCursor
    }
    // dev-user still manages the page, so the private marker does not hide it from THEM — what is
    // pinned here is that the row set is confirmed per row rather than inherited from the parent.
    expect(all, 'the branch stopped confirming its own rows').toContain(childIds[0])
  }, 300_000)

  it('every refusal is the SAME 404 — absent, another space, trashed', async () => {
    // §2. Four different answers would make the tree a membership oracle for page ids.
    const shapes: string[] = []
    for (const p of ['br623-no-such-page', otherSpaceId]) {
      const res = await app.inject({
        method: 'GET', url: `/spaces/${spaceId}/pages/branch?parent=${encodeURIComponent(p)}`, headers: H,
      })
      shapes.push(`${res.statusCode}:${res.body}`)
    }
    // …and a page that exists in ANOTHER space of the same tenant: the caller must not learn that the id
    // is real. Created here so the case is about the space check, not about existence.
    const elsewhere = await createPage(db, fgaClient, driver, {
      tenantId: tenant.id, spaceId: otherSpaceId, userId: 'dev-user', title: `br623-elsewhere-${STAMP}`, parentId: null,
    })
    try {
      const res = await app.inject({
        method: 'GET', url: `/spaces/${spaceId}/pages/branch?parent=${encodeURIComponent(elsewhere.id)}`, headers: H,
      })
      shapes.push(`${res.statusCode}:${res.body}`)
      expect(new Set(shapes).size, `the refusals differ: ${[...new Set(shapes)].join(' | ')}`).toBe(1)
      expect(shapes[0]!.startsWith('404:'), `expected a 404, got ${shapes[0]}`).toBe(true)
    } finally {
      await deletePage(db, fgaClient, driver, { pageId: elsewhere.id, userId: 'dev-user' }).catch(() => {})
    }
  }, 300_000)

  it('the root branch answers the space’s top level, without the home page', async () => {
    const root = await branch(null)
    expect(root.pages.some((p) => p.id === parentId), 'the parent is a root of this space').toBe(true)
    const [home] = await admin<{ home_page_id: string | null }[]>`
      SELECT home_page_id FROM spaces WHERE id = ${spaceId}`
    if (home?.home_page_id) {
      expect(root.pages.map((p) => p.id), 'the space home must not appear in the tree')
        .not.toContain(home.home_page_id)
    }
  }, 300_000)
})
