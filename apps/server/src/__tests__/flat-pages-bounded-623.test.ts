// #623 / ADR-220 §6.1: the MCP `list_pages` tool reads a space FLAT, and branch paging means nothing to
// it. So it keeps the flat contract and gets an explicit bound WITH a cursor.
//
// ⚠️ The bound is only half of it. A listing that quietly stops at its limit is the silent truncation
// this whole ticket exists to remove — worse here than on a screen, because the reader is a model that
// will report the rest as ABSENT rather than as unseen. So the answer has to SAY there is more, and the
// last case is about exactly that sentence.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { TenantRegistry } from '../db/registry.js'
import { acquireTenantDb } from '../db/tenant-db.js'
import type { TenantDb } from '../db/index.js'
import { fgaClient } from '@wikistead/authz'
import { LogicalSearchDriver } from '../search/index.js'
import { createSpace, deleteSpace } from '../routes/spaces.js'
import { createPage, deletePage, listPagesFlat } from '../routes/pages.js'
import type { Tenant } from '@wikistead/types'

const driver = new LogicalSearchDriver()
const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const STAMP = Date.now().toString(36)
const N = 9
const PAGE = 3
const SUBJ = 'user:dev-user'

let tenant: Tenant, db: TenantDb
let space: string
const ids: string[] = []

beforeAll(async () => {
  tenant = (await new TenantRegistry(pool).findBySlug('dev'))!
  db = await acquireTenantDb(tenant)
  space = (await createSpace(db, fgaClient, {
    tenantId: tenant.id, userId: 'dev-user', plan: tenant.plan, name: `fp623-${STAMP}`,
  })).id
  // A mix of roots and children: the flat listing spans the whole space, not one branch.
  let parent: string | null = null
  for (let i = 0; i < N; i++) {
    const id: string = (await createPage(db, fgaClient, driver, {
      tenantId: tenant.id, spaceId: space, userId: 'dev-user',
      title: `fp623-${String(i).padStart(2, '0')}`, parentId: i % 3 === 0 ? null : parent,
    })).id
    if (i % 3 === 0) parent = id
    ids.push(id)
  }
}, 300_000)

afterAll(async () => {
  for (const id of [...ids].reverse()) {
    await deletePage(db, fgaClient, driver, { pageId: id, userId: 'dev-user' }).catch(() => {})
  }
  await deleteSpace(db, fgaClient, driver, { tenantId: tenant.id, spaceId: space, userId: 'dev-user' }).catch(() => {})
  await db.release(); await pool.end({ timeout: 5 }); await admin.end()
}, 300_000)

const flat = (cursor?: string) =>
  listPagesFlat(db, fgaClient, { spaceId: space, subject: SUBJ, limit: PAGE, ...(cursor ? { cursor } : {}) })

describe('#623 / ADR-220 §6.1: the flat listing is bounded and says when it was cut', () => {
  it('one response does not carry the whole space', async () => {
    const first = await flat()
    expect(first.pages.length).toBe(PAGE)
    expect(first.nextCursor, 'the fixture fits in one page — nothing below is being tested').toBeTruthy()
  }, 300_000)

  it('⚠️ it SAYS there is more — a listing that stops silently is the defect, not the bound', async () => {
    // The half that matters for a model reading this: without the marker it cannot tell "these are all
    // the pages" from "these are the first few", and it will answer the user as though the rest do not
    // exist.
    const first = await flat()
    expect(first.nextCursor).toBe(first.pages.at(-1)!.id)
    const last = await flat(ids[ids.length - 1])
    expect(last.nextCursor, 'the final page must NOT claim there is more').toBeNull()
  }, 300_000)

  it('walking returns every page exactly once, across branches', async () => {
    const seen: string[] = []
    let cursor: string | undefined
    for (let guard = 0; guard < 50; guard++) {
      const page = await flat(cursor)
      seen.push(...page.pages.map((p) => p.id))
      if (!page.nextCursor) break
      cursor = page.nextCursor
    }
    const repeats = seen.filter((s, i) => seen.indexOf(s) !== i)
    expect(repeats, `returned twice: ${[...new Set(repeats)].join(', ')}`).toEqual([])
    const truth = (await admin<{ id: string }[]>`
      SELECT p.id FROM pages p JOIN spaces s ON s.id = p.space_id
       WHERE p.space_id = ${space} AND p.deleted_at IS NULL
         AND (s.home_page_id IS NULL OR p.id != s.home_page_id)
       ORDER BY p.position, p.created_at`).map((r) => r.id)
    expect(seen, 'the walk did not return the space in its own order').toEqual(truth)
  }, 300_000)

  it('the listing stays FLAT — children and roots alike', async () => {
    // §6.1's whole point: branch paging is meaningless to this caller, so the shape must not quietly
    // become per-branch. The fixture has both, and both must appear.
    const all: string[] = []
    let cursor: string | undefined
    for (let guard = 0; guard < 50; guard++) {
      const page = await flat(cursor)
      all.push(...page.pages.map((p) => p.id))
      if (!page.nextCursor) break
      cursor = page.nextCursor
    }
    const kinds = await admin<{ id: string; parent_id: string | null }[]>`
      SELECT id, parent_id FROM pages WHERE space_id = ${space} AND deleted_at IS NULL`
    expect(kinds.some((k) => k.parent_id === null), 'the fixture has no roots').toBe(true)
    expect(kinds.some((k) => k.parent_id !== null), 'the fixture has no children').toBe(true)
    for (const k of kinds) expect(all, `${k.id} is missing from the flat listing`).toContain(k.id)
  }, 300_000)
})
