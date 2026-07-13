// #322 / ADR-133 §6 (increment ②, inert index slice): the page_links edge index. extractPageLinks is the
// pure derivation (from published markdown); syncPageLinks replaces a page's outbound edges in a tx. The
// index is INERT (nothing reads it yet), so this covers the derivation + the delete-then-insert + the
// FK-cascade cleanup — the read-side view-filter arrives with the 2-hop query slice. Real Postgres.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { TenantRegistry } from '../db/registry.js'
import { acquireTenantDb } from '../db/tenant-db.js'
import type { TenantDb } from '../db/index.js'
import { fgaClient } from '@wikistead/authz'
import { LogicalSearchDriver } from '../search/index.js'
import { createSpace, deleteSpace } from '../routes/spaces.js'
import { createPage, deletePage, extractPageLinks, syncPageLinks } from '../routes/pages.js'
import type { Tenant } from '@wikistead/types'

const UUID_A = '11111111-1111-4111-8111-111111111111'
const UUID_B = '22222222-2222-4222-8222-222222222222'
const UUID_SELF = '33333333-3333-4333-8333-333333333333'

describe('extractPageLinks (#322 / ADR-133 §6 — pure derivation)', () => {
  it('extracts /p/<id> links (type=link) and :::embed-page bodies (type=embed)', () => {
    const md = `see [target](/p/${UUID_A}) for details\n\n:::embed-page\n${UUID_B}\n:::\n`
    const edges = extractPageLinks(md, UUID_SELF).sort((a, b) => a.toId.localeCompare(b.toId))
    expect(edges).toEqual([
      { toId: UUID_A, type: 'link' },
      { toId: UUID_B, type: 'embed' },
    ])
  })

  it('drops self-references and de-duplicates repeated edges', () => {
    const md = `[self](/p/${UUID_SELF}) [a](/p/${UUID_A}) again [a2](/p/${UUID_A})`
    expect(extractPageLinks(md, UUID_SELF)).toEqual([{ toId: UUID_A, type: 'link' }])
  })

  it('a bare-substring mention is NOT an edge (precise reference only)', () => {
    const md = `the id ${UUID_A} appears mid-sentence but is not a link or an embed body`
    expect(extractPageLinks(md, UUID_SELF)).toEqual([])
  })

  it('the SAME target via BOTH a link and an embed yields two typed edges', () => {
    const md = `[x](/p/${UUID_A})\n\n:::embed-page\n${UUID_A}\n:::`
    const edges = extractPageLinks(md, UUID_SELF).map((e) => e.type).sort()
    expect(edges).toEqual(['embed', 'link'])
  })
})

const adminPool = postgres(process.env.DATABASE_ADMIN_URL!)
let tenant: Tenant
let db: TenantDb
let spaceId: string
const ids: string[] = []

async function edgesOf(fromId: string): Promise<{ to: string; type: string }[]> {
  const rows = await db.sql<{ to_page_id: string; type: string }[]>`
    SELECT to_page_id, type FROM page_links WHERE from_page_id = ${fromId} ORDER BY to_page_id, type
  `
  return rows.map((r) => ({ to: r.to_page_id, type: r.type }))
}

describe('syncPageLinks (#322 — tx-scoped replace + FK cascade)', () => {
  const driver = new LogicalSearchDriver()
  beforeAll(async () => {
    const registry = new TenantRegistry(pool)
    tenant = (await registry.findBySlug('dev'))!
    db = await acquireTenantDb(tenant)
    const space = await createSpace(db, fgaClient, { tenantId: tenant.id, userId: 'dev-user', plan: tenant.plan, name: 'page-links-space' })
    spaceId = space.id
  }, 60_000)

  afterAll(async () => {
    for (const id of ids) await deletePage(db, fgaClient, driver, { pageId: id, userId: 'dev-user' }).catch(() => {})
    await deleteSpace(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user' }).catch(() => {})
    await db.release()
    await pool.end()
    await adminPool.end()
  }, 60_000)

  it('writes the derived edges, then REPLACES them on a re-sync (idempotent, no stale rows)', async () => {
    const src = await createPage(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user', title: 'Src' })
    ids.push(src.id)
    const a = await createPage(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user', title: 'A' })
    const b = await createPage(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user', title: 'B' })
    ids.push(a.id, b.id)

    await db.tx(async (tx) => syncPageLinks(tx, tenant.id, src.id, `[a](/p/${a.id}) and :::embed-page\n${b.id}\n:::`))
    expect(await edgesOf(src.id)).toEqual(
      [{ to: a.id, type: 'link' }, { to: b.id, type: 'embed' }].sort((x, y) => x.to.localeCompare(y.to)),
    )

    // Re-sync with only the A link → the B embed edge is gone (replace, not append).
    await db.tx(async (tx) => syncPageLinks(tx, tenant.id, src.id, `only [a](/p/${a.id}) now`))
    expect(await edgesOf(src.id)).toEqual([{ to: a.id, type: 'link' }])

    // Null md (unpublish) clears the edges entirely.
    await db.tx(async (tx) => syncPageLinks(tx, tenant.id, src.id, null))
    expect(await edgesOf(src.id)).toEqual([])
  }, 60_000)

  it('deleting the source page CASCADES its outbound edges away (FK ON DELETE CASCADE)', async () => {
    const src = await createPage(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user', title: 'Src2' })
    const a = await createPage(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user', title: 'A2' })
    ids.push(a.id)
    await db.tx(async (tx) => syncPageLinks(tx, tenant.id, src.id, `[a](/p/${a.id})`))
    expect(await edgesOf(src.id)).toHaveLength(1)
    await deletePage(db, fgaClient, driver, { pageId: src.id, userId: 'dev-user' })
    expect(await edgesOf(src.id)).toEqual([])
  }, 60_000)
})
