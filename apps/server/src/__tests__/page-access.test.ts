// Integration test — real Postgres + OpenFGA + Meilisearch, no mocks.
// Phase 4b per-page grant/revoke/list. Only a `manage` holder may grant/revoke/list;
// a grant makes the grantee a real FGA viewer (and a search viewer after reindex); a
// revoke drops them; granting on a DRAFT is how you invite someone to it.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import * as Y from 'yjs'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { fgaClient, check, deleteObjectTuples } from '@wikistead/authz'
import { LogicalSearchDriver, buildSearchDoc } from '../search/index.js'
import { createSpace, deleteSpace } from '../routes/spaces.js'
import { createPage, grantPageAccess, revokePageAccess, listPageAccess } from '../routes/pages.js'
import { drainAuditOutbox } from '../audit/outbox.js'
import type { Tenant } from '@wikistead/types'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const driver = new LogicalSearchDriver()
const TENANT = 'tenant_dev'
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'free', isolation: 'logical' }) as Tenant
const GRANTEE = 'user:pa-grantee'
const STRANGER = 'pa-stranger'
const TITLE = `paccess${Date.now().toString(36)}`
const ydoc = (t: string) => Buffer.from(Y.encodeStateAsUpdate((() => { const d = new Y.Doc(); d.getText('content').insert(0, t); return d })()))
const wait = () => new Promise((r) => setTimeout(r, 500))
const search = (userId: string) => driver.search({ tenantId: TENANT, userId, groups: [], q: TITLE })

let db: TenantDb, spaceId: string, pageId: string

beforeAll(async () => {
  await driver.ensureIndex()
  db = await acquireTenantDb(asTenant(TENANT))
  spaceId = (await createSpace(db, fgaClient, { tenantId: TENANT, userId: 'dev-user', plan: 'free', name: 'pa-space' })).id
  // A DRAFT page (creator-only) — granting on it is exactly "invite to a draft".
  pageId = (await createPage(db, fgaClient, driver, { tenantId: TENANT, spaceId, userId: 'dev-user', title: TITLE })).id
  await admin`UPDATE pages SET ydoc = ${ydoc(`# ${TITLE}\n`)} WHERE id = ${pageId}`
}, 30_000)

afterAll(async () => {
  await driver.deleteDoc(pageId).catch(() => {})
  await deleteObjectTuples(fgaClient, `page:${pageId}`).catch(() => {})
  await admin`DELETE FROM search_outbox WHERE page_id = ${pageId}`.catch(() => {})
  await admin`DELETE FROM audit_log WHERE tenant_id = ${TENANT}`.catch(() => {})
  await admin`DELETE FROM audit_outbox WHERE tenant_id = ${TENANT}`.catch(() => {})
  await admin`DELETE FROM pages WHERE id = ${pageId}`.catch(() => {})
  await deleteSpace(db, fgaClient, driver, { tenantId: TENANT, spaceId, userId: 'dev-user' }).catch(() => {})
  await db.release()
  await admin.end()
  await pool.end()
}, 30_000)

describe('per-page access (grant/revoke/list)', () => {
  it('a manager grants view (invite to a draft): grantee gains FGA view AND appears in search', async () => {
    expect(await check(fgaClient, GRANTEE, 'view', { type: 'page', id: pageId })).toBe(false)
    await grantPageAccess(db, fgaClient, driver, { pageId, tenantId: TENANT, userId: 'dev-user', grantee: GRANTEE, relation: 'view' })
    expect(await check(fgaClient, GRANTEE, 'view', { type: 'page', id: pageId })).toBe(true)
    const doc = await buildSearchDoc(pool, fgaClient, pageId, TENANT)
    expect(doc!.viewerUsers).toContain(GRANTEE)
    await driver.upsertDoc(doc!)
    await wait()
    expect((await search('pa-grantee')).some((h) => h.id === pageId)).toBe(true)
  })

  it('a non-manager cannot grant (403)', async () => {
    await expect(grantPageAccess(db, fgaClient, driver, { pageId, tenantId: TENANT, userId: STRANGER, grantee: 'user:pa-x', relation: 'view' }))
      .rejects.toMatchObject({ statusCode: 403 })
  })

  it('list returns direct grantees for a manager; a non-manager is rejected (403)', async () => {
    const list = await listPageAccess(fgaClient, db, { pageId, tenantId: TENANT, userId: 'dev-user' })
    expect(list).toEqual(expect.arrayContaining([
      { grantee: GRANTEE, relation: 'view' },
      { grantee: 'user:dev-user', relation: 'manage' }, // the creator grant
    ]))
    await expect(listPageAccess(fgaClient, db, { pageId, tenantId: TENANT, userId: STRANGER })).rejects.toMatchObject({ statusCode: 403 })
  })

  it('revoke removes FGA view and drops the grantee from search', async () => {
    await revokePageAccess(db, fgaClient, driver, { pageId, tenantId: TENANT, userId: 'dev-user', grantee: GRANTEE, relation: 'view' })
    expect(await check(fgaClient, GRANTEE, 'view', { type: 'page', id: pageId })).toBe(false)
    const doc = await buildSearchDoc(pool, fgaClient, pageId, TENANT)
    expect(doc!.viewerUsers).not.toContain(GRANTEE)
    await driver.upsertDoc(doc!)
    await wait()
    expect((await search('pa-grantee')).some((h) => h.id === pageId)).toBe(false)
  })

  it('rejects an invalid grantee or relation (400) — share_link / wildcard / unknown relation', async () => {
    await expect(grantPageAccess(db, fgaClient, driver, { pageId, tenantId: TENANT, userId: 'dev-user', grantee: 'share_link:x', relation: 'view' }))
      .rejects.toMatchObject({ statusCode: 400 })
    await expect(grantPageAccess(db, fgaClient, driver, { pageId, tenantId: TENANT, userId: 'dev-user', grantee: 'user:*', relation: 'view' }))
      .rejects.toMatchObject({ statusCode: 400 })
    await expect(grantPageAccess(db, fgaClient, driver, { pageId, tenantId: TENANT, userId: 'dev-user', grantee: GRANTEE, relation: 'owner' }))
      .rejects.toMatchObject({ statusCode: 400 })
  })

  it('records a durable page.access_granted audit entry when entitled + plan passed (#177)', async () => {
    await grantPageAccess(db, fgaClient, driver, { pageId, tenantId: TENANT, userId: 'dev-user', grantee: 'user:pa-audit', relation: 'view', plan: 'team' })
    expect(await drainAuditOutbox()).toBeGreaterThanOrEqual(1)
    const rows = await db.sql<{ action: string; target: string; actor: string }[]>`SELECT action, target, actor FROM audit_log WHERE tenant_id = ${TENANT} ORDER BY seq`
    expect(rows.some((r) => r.action === 'page.access_granted' && r.target === `page:${pageId}` && r.actor === 'user:dev-user')).toBe(true)
    await deleteObjectTuples(fgaClient, `page:${pageId}`).catch(() => {}) // clean the extra grantee tuple
  })
})
