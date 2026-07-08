// #108 / ADR-071: the host-mediated page-view gate. A principal resolves an embedded resource
// only after OpenFGA confirms `view` on its page — verified with DISTINCT subjects (the creator
// passes; a stranger is denied), the two return shapes (throw 404 vs boolean) pinned. #280: the
// throw is 404 'not found' (existence-hiding), indistinguishable from a missing resource.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { fgaClient, deleteObjectTuples } from '@wikistead/authz'
import { LogicalSearchDriver } from '../search/index.js'
import { createSpace, deleteSpace } from '../routes/spaces.js'
import { createPage } from '../routes/pages.js'
import { assertPageViewable, canViewPage } from '../page-view-gate.js'
import type { Tenant } from '@wikistead/types'

const driver = new LogicalSearchDriver()
const TENANT = 'tenant_dev'
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'free', isolation: 'logical' }) as Tenant
let db: TenantDb, spaceId: string, pageId: string

beforeAll(async () => {
  db = await acquireTenantDb(asTenant(TENANT))
  spaceId = (await createSpace(db, fgaClient, { tenantId: TENANT, userId: 'dev-user', plan: 'free', name: `pvg-${Date.now().toString(36)}` })).id
  pageId = (await createPage(db, fgaClient, driver, { tenantId: TENANT, spaceId, userId: 'dev-user', title: 'pvg' })).id // dev-user → manage⊃view
}, 30_000)
afterAll(async () => {
  await deleteObjectTuples(fgaClient, `page:${pageId}`).catch(() => {})
  await deleteSpace(db, fgaClient, driver, { tenantId: TENANT, spaceId, userId: 'dev-user' }).catch(() => {})
  await db.release(); await pool.end()
}, 30_000)

describe('page-view gate (#108 / ADR-071)', () => {
  it('canViewPage: true for a viewer, false for a stranger', async () => {
    expect(await canViewPage(fgaClient, 'user:dev-user', pageId)).toBe(true)
    expect(await canViewPage(fgaClient, 'user:pvg-stranger', pageId)).toBe(false)
  })

  it('assertPageViewable: resolves for a viewer, throws 404 not-found for a stranger (existence-hiding)', async () => {
    await expect(assertPageViewable(fgaClient, 'user:dev-user', pageId)).resolves.toBeUndefined()
    await expect(assertPageViewable(fgaClient, 'user:pvg-stranger', pageId)).rejects.toMatchObject({ statusCode: 404, message: 'not found' })
  })
})
