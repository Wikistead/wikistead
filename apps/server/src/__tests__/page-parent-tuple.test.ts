// #218 / ADR-103 prep slice: the structural `page#parent` FGA tuple must track the DB parent_id on every
// create/move. The `parent` relation is UNWIRED (no authz effect yet), so this verifies the PLUMBING only —
// the tuple exists / is re-pointed / is removed — which the follow-up model change will start reading.
import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { pool } from '../db/pool.js'
import { TenantRegistry } from '../db/registry.js'
import { acquireTenantDb } from '../db/tenant-db.js'
import type { TenantDb } from '../db/index.js'
import { fgaClient } from '@wikistead/authz'
import { LogicalSearchDriver } from '../search/index.js'
import { createSpace, deleteSpace } from '../routes/spaces.js'
import { createPage, movePage } from '../routes/pages.js'
import type { Tenant } from '@wikistead/types'

const driver = new LogicalSearchDriver()
let tenant: Tenant
let db: TenantDb
let spaceId: string

beforeAll(async () => {
  const registry = new TenantRegistry(pool)
  tenant = (await registry.findBySlug('dev'))!
  db = await acquireTenantDb(tenant)
  const space = await createSpace(db, fgaClient, { tenantId: tenant.id, userId: 'dev-user', plan: tenant.plan, name: 'parent-tuple-space' })
  spaceId = space.id
})
afterAll(async () => {
  await deleteSpace(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user' })
  await db.release()
  await pool.end()
})

// The parent(s) a page currently points at via the page#parent tuple (user ids, sans "page:" prefix).
async function parentsOf(pageId: string): Promise<string[]> {
  const { tuples } = await fgaClient.read({ object: `page:${pageId}`, relation: 'parent' })
  return (tuples ?? []).map(({ key }) => key!.user.replace(/^page:/, '')).sort()
}
const mk = (title: string, parentId: string | null = null) =>
  createPage(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user', title, parentId })

describe('#218 page#parent tuple sync (inert plumbing, ADR-103 prep)', () => {
  it('createPage writes a page#parent tuple when nested; none at top level', async () => {
    const top = await mk('P-top')
    expect(await parentsOf(top.id)).toEqual([]) // top-level page has no parent tuple
    const child = await mk('P-child', top.id)
    expect(await parentsOf(child.id)).toEqual([top.id]) // nested → tuple points at the parent
  })

  it('movePage re-points the tuple to the new parent (old removed)', async () => {
    const a = await mk('A')
    const b = await mk('B')
    const child = await mk('child', a.id)
    expect(await parentsOf(child.id)).toEqual([a.id])
    await movePage(db, fgaClient, driver, { pageId: child.id, userId: 'dev-user', parentId: b.id, afterId: null })
    expect(await parentsOf(child.id)).toEqual([b.id]) // exactly one parent — old A tuple removed, B added
  })

  it('movePage to top level removes the parent tuple', async () => {
    const p = await mk('P2')
    const child = await mk('child2', p.id)
    expect(await parentsOf(child.id)).toEqual([p.id])
    await movePage(db, fgaClient, driver, { pageId: child.id, userId: 'dev-user', parentId: null, afterId: null })
    expect(await parentsOf(child.id)).toEqual([]) // reparented to root → no parent tuple
  })
})
