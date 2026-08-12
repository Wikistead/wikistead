import { it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { TenantRegistry } from '../db/registry.js'
import { acquireTenantDb } from '../db/tenant-db.js'
import type { TenantDb } from '../db/index.js'
import { fgaClient, writeTuples, filterAuthorized } from '@wikistead/authz'
import { LogicalSearchDriver } from '../search/index.js'
import { LogicalStorageDriver } from '../storage/index.js'
import { createSpace, deleteSpace } from '../routes/spaces.js'
import { createPage, publishPage, listBranch } from '../routes/pages.js'
import type { Tenant } from '@wikistead/types'

const driver = new LogicalSearchDriver()
const storage = new LogicalStorageDriver()
const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const STAMP = Date.now().toString(36)
let tenant: Tenant, db: TenantDb, spaceId: string
const READER = `user:zzprobe-${STAMP}`

beforeAll(async () => {
  tenant = (await new TenantRegistry(pool).findBySlug('dev'))!
  db = await acquireTenantDb(tenant)
  const s = await createSpace(db, fgaClient, { tenantId: tenant.id, userId: 'dev-user', plan: tenant.plan, name: `probe-${STAMP}` })
  spaceId = s.id
  await writeTuples(fgaClient, [
    { user: READER, relation: 'member', object: `tenant:${tenant.id}` },
    { user: READER, relation: 'viewer', object: `space:${spaceId}` },
  ]).catch(() => {})
}, 120_000)
afterAll(async () => {
  await deleteSpace(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user' }).catch(() => {})
  await db.release(); await pool.end({ timeout: 5 }); await admin.end()
}, 120_000)

it('probe', async () => {
  const a = await createPage(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user', title: 'A', parentId: null })
  await publishPage(db, fgaClient, driver, storage, { pageId: a.id, subject: 'user:dev-user', createdBy: 'user:dev-user' })
  const kid = await createPage(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user', title: 'K', parentId: a.id })
  await publishPage(db, fgaClient, driver, storage, { pageId: kid.id, subject: 'user:dev-user', createdBy: 'user:dev-user' })

  const kids = await db.sql<{ id: string; parent_id: string }[]>`
    SELECT id, parent_id FROM (
      SELECT p.id, p.parent_id,
             ROW_NUMBER() OVER (PARTITION BY p.parent_id ORDER BY p.position, p.created_at) AS rn
      FROM pages p JOIN spaces s ON s.id = p.space_id
      WHERE p.parent_id = ANY(${[a.id]}) AND p.space_id = ${spaceId}
        AND p.deleted_at IS NULL AND (s.home_page_id IS NULL OR p.id != s.home_page_id)
    ) x WHERE rn <= 3`
  console.log('PROBE kids=', JSON.stringify(kids))
  const checked = await filterAuthorized(fgaClient, READER, 'view', [a.id, kid.id])
  console.log('PROBE checked=', JSON.stringify(checked))
  const b = await listBranch(db, fgaClient, { spaceId, parentId: null, subject: READER })
  console.log('PROBE branch=', JSON.stringify(b.pages.map((p) => ({ id: p.id, hc: (p as { hasChildren?: boolean }).hasChildren }))))
  expect(true).toBe(true)
}, 120_000)
