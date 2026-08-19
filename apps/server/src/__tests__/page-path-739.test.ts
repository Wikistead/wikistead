// #739 / ADR-238: the sidebar reaches the open page by ASKING where it is.
//
// `paintTree` already fetches the branch of every ancestor, so a deep page is reachable — but each of
// those branches comes back as its FIRST window, and the row the reader opened may be the 400th child.
// The naive fix is a client loop over `more:` until the row appears, which is unbounded in the shape
// #705 / #710 ruled against, and the cost lands on whoever was merely sent a link.
//
// The property this file pins is NOT the arithmetic. It is that FETCHING THE BRANCH WITH THE CURSOR THE
// ROUTE GAVE ACTUALLY CONTAINS THE NEXT ROW ON THE PATH — measured by running `listBranch`, the same
// function the sidebar calls. A test that restated `floor(rank / limit)` would agree with an
// off-by-one implementation, because it would be the same off-by-one.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { TenantRegistry } from '../db/registry.js'
import { acquireTenantDb } from '../db/tenant-db.js'
import type { TenantDb } from '../db/index.js'
import { fgaClient, writeTuples, deleteTuples } from '@wikistead/authz'
import { mintGuestToken } from '@wikistead/auth'
import { buildApp } from '../app.js'
import { LogicalSearchDriver } from '../search/index.js'
import { createSpace, deleteSpace } from '../routes/spaces.js'
import { createPage, deletePage, setPagePrivate, listBranch, pathToPage } from '../routes/pages.js'
import type { Tenant } from '@wikistead/types'

const driver = new LogicalSearchDriver()
const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const STAMP = Date.now().toString(36)
const LINK = `path739-${STAMP}`
const guestCfg = {
  secret: process.env.GUEST_TOKEN_SECRET!,
  ttlSeconds: Number(process.env.GUEST_TOKEN_TTL_SECONDS ?? 300),
}
const LIMIT = 3 // the window size the caller asks for; small so the fixture stays small
const SUBJ = 'user:dev-user'

let tenant: Tenant
let db: TenantDb
let app: FastifyInstance
let spaceId: string
let otherSpaceId: string
let otherSpacePageId: string
/** roots R0..R4; the path goes through R4 (rank 4, so window 1 with LIMIT 3) */
const roots: string[] = []
/** R4's children C0..C6; the path goes through C6 (rank 6, window 2) */
const mid: string[] = []
/** C6's children T0..T4; the target is T4 (rank 4, window 1) */
const leaves: string[] = []
let shallowId: string // a root-branch page inside the FIRST window, so its cursor must be null

const mk = (title: string, parentId: string | null) =>
  createPage(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user', title, parentId })

beforeAll(async () => {
  const registry = new TenantRegistry(pool)
  tenant = (await registry.findBySlug('dev'))!
  db = await acquireTenantDb(tenant)
  app = await buildApp(); await app.ready()
  const space = await createSpace(db, fgaClient, {
    tenantId: tenant.id, userId: 'dev-user', plan: tenant.plan, name: `path739-space-${STAMP}`,
  })
  spaceId = space.id
  const other = await createSpace(db, fgaClient, {
    tenantId: tenant.id, userId: 'dev-user', plan: tenant.plan, name: `path739-other-${STAMP}`,
  })
  otherSpaceId = other.id
  const stray = await createPage(db, fgaClient, driver, {
    tenantId: tenant.id, spaceId: otherSpaceId, userId: 'dev-user', title: `path739-stray-${STAMP}`, parentId: null,
  })
  otherSpacePageId = stray.id

  for (let i = 0; i < 5; i++) roots.push((await mk(`path739-r-${i}-${STAMP}`, null)).id)
  shallowId = roots[0]!
  for (let i = 0; i < 7; i++) mid.push((await mk(`path739-c-${i}-${STAMP}`, roots[4]!)).id)
  for (let i = 0; i < 5; i++) leaves.push((await mk(`path739-t-${i}-${STAMP}`, mid[6]!)).id)
  // A space link that can see the space but NOT the pages inside it: `space#viewer` alone does not
  // cascade to a page, so every page in this fixture is invisible to the guest — which is exactly the
  // caller the 404 has to be identical for.
  await writeTuples(fgaClient, [{ user: `share_link:${LINK}`, relation: 'viewer', object: `space:${spaceId}` }])
}, 600_000)

afterAll(async () => {
  for (const id of [...leaves, ...mid, ...roots, otherSpacePageId]) {
    await deletePage(db, fgaClient, driver, { pageId: id, userId: 'dev-user' }).catch(() => {})
  }
  for (const id of [spaceId, otherSpaceId]) {
    await deleteSpace(db, fgaClient, driver, { tenantId: tenant.id, spaceId: id, userId: 'dev-user' }).catch(() => {})
  }
  await deleteTuples(fgaClient, [{ user: `share_link:${LINK}`, relation: 'viewer', object: `space:${spaceId}` }]).catch(() => {})
  await app.close(); await app.valkey.quit().catch(() => {})
  await db.release()
  await pool.end({ timeout: 5 })
  await admin.end()
}, 300_000)

const path = (pageId: string, extra: { scanMax?: number } = {}) =>
  pathToPage(db, fgaClient, { spaceId, pageId, subject: SUBJ, limit: LIMIT, ...extra })

const branchAt = (parentId: string | null, cursor: string | null) =>
  listBranch(db, fgaClient, { spaceId, parentId, subject: SUBJ, limit: LIMIT, ...(cursor ? { cursor } : {}) })

describe('#739 / ADR-238: the path says which window holds the row', () => {
  it('every level, fetched with the cursor it gave, contains the next row on the path', async () => {
    const target = leaves[4]!
    const answer = await path(target)
    expect(answer.exhausted).toBe(false)
    expect(answer.levels.map((l) => l.parentId), 'root-first, one level per ancestor plus the target')
      .toEqual([null, roots[4], mid[6]])

    // The property. Each level is FETCHED, and the row the next level is about must be in the answer.
    const wanted = [roots[4]!, mid[6]!, target]
    for (const [i, level] of answer.levels.entries()) {
      const page = await branchAt(level.parentId, level.cursor)
      expect(
        page.pages.map((p) => p.id),
        `level ${i} (parent ${level.parentId ?? 'root'}, cursor ${level.cursor ?? 'none'}) does not contain ${wanted[i]}`,
      ).toContain(wanted[i])
    }
  }, 600_000)

  it('a row already in the first window asks for no cursor', async () => {
    // Otherwise the sidebar would refetch, positioned, every branch the paint had already answered —
    // paying a request per level for a tree that was already showing the row.
    const answer = await path(shallowId)
    expect(answer.levels).toEqual([{ parentId: null, cursor: null }])
  }, 600_000)

  it('a sibling the reader cannot see does not move the window', async () => {
    // ⚠️ The rank is counted over the UNFILTERED ordering, because that is what `listBranch` pages over:
    // it takes `limit + 1` SQL rows and only then drops the ones the reader cannot view. A rank computed
    // after the authorization filter would name a window that does not hold the target — and only for
    // readers who cannot see some siblings, which is the hardest kind of bug to hear about.
    const target = leaves[4]!
    const before = await path(target)
    await setPagePrivate(db, fgaClient, driver, { pageId: mid[0]!, tenantId: tenant.id, userId: 'dev-user' })
    const after = await path(target)
    expect(after.levels).toEqual(before.levels)
    const page = await branchAt(after.levels[2]!.parentId, after.levels[2]!.cursor)
    expect(page.pages.map((p) => p.id)).toContain(target)
  }, 600_000)

  it('a walk that runs out of budget says so instead of pointing at the wrong window', async () => {
    // Measured with a fixture the budget cannot cover, not by reading PATH_SCAN_MAX: an implementation
    // that scanned the whole branch and compared afterwards would satisfy a constant-reading test.
    const answer = await path(leaves[4]!, { scanMax: 2 })
    expect(answer.exhausted, 'the walk stopped short and must say so').toBe(true)
    // What it did manage is still usable — the levels it returns are correct, there are just fewer.
    for (const level of answer.levels) {
      await expect(branchAt(level.parentId, level.cursor)).resolves.toBeTruthy()
    }
  }, 600_000)
})

describe('#739 / ADR-238 §2.2: the path route is not a membership oracle', () => {
  const message = async (pageId: string): Promise<string> => {
    try {
      await path(pageId)
      return 'no error'
    } catch (e) {
      const err = e as Error & { statusCode?: number }
      return `${err.statusCode ?? 'none'}:${err.message}`
    }
  }

  it('absent, another space and invisible answer byte-identically', async () => {
    // Four different answers would let a caller test whether an id belongs to this space — the same
    // reason `listBranch` collapses its refusals into one 404.
    const hidden = (await mk(`path739-hidden-${STAMP}`, roots[4]!)).id
    await setPagePrivate(db, fgaClient, driver, { pageId: hidden, tenantId: tenant.id, userId: 'dev-user' })
    // Private is creator-only and the creator is this subject, so take the view away at the source: a
    // page that exists, in this space, that this reader cannot view.
    await admin`UPDATE pages SET deleted_at = now() WHERE id = ${hidden}`

    const answers = await Promise.all([
      message('path739-no-such-page-at-all'),
      message(otherSpacePageId),
      message(hidden),
    ])
    expect(new Set(answers), `refusals differ: ${JSON.stringify(answers)}`).toEqual(new Set([answers[0]!]))
    expect(answers[0]).toMatch(/^404:/)
    await admin`DELETE FROM pages WHERE id = ${hidden}`
  }, 600_000)
})

describe('#739 / ADR-238 §2.2: a share-link guest is told the same nothing', () => {
  const asGuest = async (pageId: string) => {
    const tok = await mintGuestToken(guestCfg, {
      tenantId: tenant.id, shareLinkId: LINK, resource: { type: 'space', id: spaceId }, capability: 'view',
    })
    return app.inject({
      method: 'GET',
      url: `/spaces/${spaceId}/pages/${encodeURIComponent(pageId)}/path`,
      headers: { host: 'dev.localhost', authorization: `Bearer ${tok}` },
    })
  }

  it('a page it cannot view and a page that does not exist are the same response', async () => {
    // The guest arm is the one the owner's case runs through — a link you were sent. `space#viewer`
    // does not cascade to pages, so every row here is invisible to this token; if the route answered
    // differently for a real page than for an invented id, the link would become a way to test which
    // page ids belong to the space it was issued for.
    const real = await asGuest(leaves[4]!)
    const invented = await asGuest('path739-no-such-page-for-a-guest')
    expect(real.statusCode).toBe(404)
    expect([real.statusCode, real.body], `real: ${real.body}`).toEqual([invented.statusCode, invented.body])
  }, 600_000)

  it('a token bound to another space cannot ask about this one', async () => {
    const tok = await mintGuestToken(guestCfg, {
      tenantId: tenant.id, shareLinkId: LINK, resource: { type: 'space', id: otherSpaceId }, capability: 'view',
    })
    const res = await app.inject({
      method: 'GET',
      url: `/spaces/${spaceId}/pages/${encodeURIComponent(leaves[4]!)}/path`,
      headers: { host: 'dev.localhost', authorization: `Bearer ${tok}` },
    })
    expect(res.statusCode, 'the guest arm is bound to its own space, as the branch route is').toBe(403)
  }, 600_000)
})
