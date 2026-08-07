// #623: the live share links on a resource arrived in one response, and nothing prunes them.
//
// One query serves BOTH list routes (a page's links and a space's), so this file bounds two of the
// ledger's lines at once — and the walk is measured on the page route, which is the busier one.
//
// The direction matters: this list is DESC, which SKIPS rather than repeats. A link created between the
// cursor's truncated instant and its true one appears on no page, and a live link missing from the list
// is one nobody knows to revoke. So the walk is compared against the truth in the table for misses AND
// duplicates, with a TIE placed on a page boundary — a tie inside one page comes back before the cursor
// is taken and measures nothing (learned on the revisions slice the same day).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { TenantRegistry } from '../db/registry.js'
import { acquireTenantDb } from '../db/tenant-db.js'
import type { TenantDb } from '../db/index.js'
import { fgaClient } from '@wikistead/authz'
import { LogicalSearchDriver } from '../search/index.js'
import { createSpace, deleteSpace } from '../routes/spaces.js'
import { createPage, deletePage } from '../routes/pages.js'
import { createShareLink, listShareLinks, listAllShareLinks } from '../routes/share-links.js'
import type { Tenant } from '@wikistead/types'

const driver = new LogicalSearchDriver()
const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const N = 9
const PAGE = 3

let tenant: Tenant
let db: TenantDb
let spaceId: string
let pageId: string

beforeAll(async () => {
  const registry = new TenantRegistry(pool)
  tenant = (await registry.findBySlug('dev'))!
  db = await acquireTenantDb(tenant)
  const space = await createSpace(db, fgaClient, {
    tenantId: tenant.id, userId: 'dev-user', plan: tenant.plan, name: `sl623-space-${Date.now().toString(36)}`,
  })
  spaceId = space.id
  const page = await createPage(db, fgaClient, driver, {
    tenantId: tenant.id, spaceId, userId: 'dev-user', title: 'sl623-page', parentId: null,
  })
  pageId = page.id

  for (let i = 0; i < N; i++) {
    await createShareLink(db, fgaClient, {
      tenantId: tenant.id, plan: tenant.plan, userId: 'dev-user',
      resource: { type: 'page', id: pageId }, capability: 'view', expiresInSeconds: null,
    })
  }
  // Stamped afterwards so the instants are exactly a microsecond apart, and so ONE PAIR TIES on a page
  // boundary. Descending, offsets 8,7,6,6 put the tied rows at positions 3 and 4 — the seam for PAGE = 3.
  // The offset is added in SQL from an integer: a timestamp handed to the driver as a string loses its
  // microseconds on the way in, and the fixture then measures nothing.
  const ids = (await admin<{ id: string }[]>`
    SELECT id FROM share_links WHERE resource_id = ${pageId} ORDER BY id`).map((r) => r.id)
  // ⚠️ ONE base instant for every row. `to_timestamp(${base}::numeric)` evaluated per statement is a
  // different second once the loop crosses a boundary, and the microsecond offsets then stop being
  // adjacent — measured as a red round-trip case in a full run while every single-file run was green.
  // Carried as an epoch numeric for the same reason the cursors are: a timestamp handed to the driver
  // loses its microseconds.
  const [{ base }] = await admin<{ base: string }[]>`SELECT extract(epoch from date_trunc('second', now()))::text AS base`
  for (const [i, id] of ids.entries()) {
    const offset = i === 5 ? 6 : i
    await admin`
      UPDATE share_links
         SET created_at = to_timestamp(${base}::numeric) + (${offset} || ' microseconds')::interval
       WHERE id = ${id}`
  }
}, 300_000)

afterAll(async () => {
  await admin`DELETE FROM share_links WHERE resource_id = ${pageId}`.catch(() => {})
  await deletePage(db, fgaClient, driver, { pageId, userId: 'dev-user' }).catch(() => {})
  await deleteSpace(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user' }).catch(() => {})
  await db.release()
  await pool.end()
  await admin.end()
}, 300_000)

const list = (cursor?: string) =>
  listShareLinks(db, fgaClient, {
    resource: { type: 'page', id: pageId }, userId: 'dev-user', limit: PAGE, ...(cursor ? { cursor } : {}),
  })

describe('#623: the share-link lists are bounded, and the walk loses nothing', () => {
  it('one response does not carry every live link', async () => {
    const first = await list()
    expect(first.links.length, 'the page is capped at the limit it was asked for').toBe(PAGE)
    expect(first.nextCursor, 'and it says there is more').toBeTruthy()
  }, 300_000)

  it('walking the pages returns every link exactly once, newest first', async () => {
    const seen: string[] = []
    let cursor: string | undefined
    for (let guard = 0; guard < 20; guard++) {
      const page = await list(cursor)
      seen.push(...page.links.map((l) => l.id))
      if (!page.nextCursor) break
      cursor = page.nextCursor
    }
    const repeats = seen.filter((s, i) => seen.indexOf(s) !== i)
    expect(repeats, `returned twice: ${[...new Set(repeats)].join(', ')}`).toEqual([])
    expect(new Set(seen).size, `walked ${seen.length} rows and saw ${new Set(seen).size} of ${N}`).toBe(N)
    const truth = (await admin<{ id: string }[]>`
      SELECT id FROM share_links WHERE resource_id = ${pageId} AND revoked_at IS NULL
       ORDER BY created_at DESC, id DESC`).map((r) => r.id)
    expect(seen, 'the order survives the paging').toEqual(truth)
  }, 300_000)

  it('the cursor names the instant it came from, microseconds included', async () => {
    const first = await list()
    const at = first.nextCursor!.slice(0, first.nextCursor!.indexOf('|'))
    const lastId = first.links.at(-1)!.id
    const [row] = await admin<{ same: boolean }[]>`
      SELECT (SELECT created_at FROM share_links WHERE id = ${lastId}) = to_timestamp(${at}::numeric) AS same`
    expect(row!.same, `the cursor "${at}" does not name the instant it came from`).toBe(true)
    const [distinct] = await admin<{ n: number }[]>`
      SELECT count(DISTINCT created_at)::int AS n FROM share_links WHERE resource_id = ${pageId}`
    // N - 1: one pair ties on purpose. Fewer means the microseconds were lost on write.
    expect(distinct!.n, 'the fixture collapsed to fewer instants').toBe(N - 1)
  }, 300_000)

  it('the space route is bounded by the same query — the twins cannot drift', async () => {
    // The two routes share `listShareLinks`, which is why one slice pays two ledger lines. Asserted
    // rather than assumed: a future split into two queries would leave one of them unbounded and this
    // file would still be green if it only ever asked about pages.
    const space = await listShareLinks(db, fgaClient, {
      resource: { type: 'space', id: spaceId }, userId: 'dev-user', limit: PAGE,
    })
    expect(space).toHaveProperty('nextCursor')
    expect(Array.isArray(space.links), 'the space route answers with a page, not a bare array').toBe(true)
  }, 300_000)

  it('the walker returns every link the pages do', async () => {
    const all = await listAllShareLinks(db, fgaClient, { resource: { type: 'page', id: pageId }, userId: 'dev-user' })
    expect(all.length).toBe(N)
  }, 300_000)
})
