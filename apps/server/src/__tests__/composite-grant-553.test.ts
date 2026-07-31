// #553 / ADR-199 §2 (T1): the editor-noun composite grant. N capabilities = N single-capability
// built-in rows in ONE transaction; each arm independently owned, revocable and idempotent; the bare
// capability form grants exactly what it says (the honest-API pin); the replace sweep keeps BOTH arms.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { fgaClient, check } from '@wikistead/authz'
import { createSpace, deleteSpace, grantSpaceAccess, revokeSpaceAccess, grantSpaceAccessComposite } from '../routes/spaces.js'
import { createPage, deletePage, publishPage } from '../routes/pages.js'
import { buildApp } from '../app.js'
import type { Tenant } from '@wikistead/types'

const adminPool = postgres(process.env.DATABASE_ADMIN_URL!)
const TENANT = 'tenant_dev'
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'business', isolation: 'logical' }) as Tenant
const STAMP = Date.now().toString(36)
const OWNER = 'dev-user'

let app: FastifyInstance
let db: TenantDb
let spaceId = ''
let pageId = ''
const subs: string[] = []
const sub = (n: string) => { const s = `cg-${n}-${STAMP}`; subs.push(s); return `user:${s}` }

const dev = { host: 'dev.localhost', authorization: 'Bearer dev-token', 'content-type': 'application/json' }

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
  db = await acquireTenantDb(asTenant(TENANT))
  spaceId = (await createSpace(db, fgaClient, { tenantId: TENANT, userId: OWNER, plan: 'business', name: `cg-${STAMP}` })).id
  pageId = (await createPage(db, fgaClient, app.searchDriver, { tenantId: TENANT, spaceId, userId: OWNER, title: `cg-${STAMP}` })).id
  await publishPage(db, fgaClient, app.searchDriver, app.storageDriver, { pageId, subject: `user:${OWNER}`, createdBy: `user:${OWNER}` })
}, 120_000)

afterAll(async () => {
  await adminPool`DELETE FROM role_assignments WHERE resource_id = ${spaceId}`.catch(() => {})
  await deletePage(db, fgaClient, app.searchDriver, { pageId, userId: OWNER }).catch(() => {})
  await deleteSpace(db, fgaClient, app.searchDriver, { tenantId: TENANT, spaceId, userId: OWNER }).catch(() => {})
  await adminPool`DELETE FROM search_outbox WHERE tenant_id = ${TENANT}`.catch(() => {})
  await db.release(); await app.close(); await adminPool.end(); await pool.end()
}, 120_000)

const rowsOf = (principal: string) => adminPool<{ id: string; builtin_capability: string | null; origin: string; owned_capabilities: string[] }[]>`
  SELECT id, builtin_capability, origin, owned_capabilities FROM role_assignments
  WHERE resource_type = 'space' AND resource_id = ${spaceId} AND principal = ${principal} ORDER BY builtin_capability`
const composite = (principal: string, caps: string[]) =>
  grantSpaceAccessComposite(db, fgaClient, app.searchDriver, { spaceId, tenantId: TENANT, userId: OWNER, grantee: principal, capabilities: caps, plan: 'business' })

describe('#553 T1: the editor-noun composite grant', () => {
  it('grants N single-capability rows in one pass; both arms hold; each is independently revocable', async () => {
    const p = sub('pair')
    await composite(p, ['edit', 'comment'])
    const rows = await rowsOf(p)
    expect(rows.map((r) => r.builtin_capability)).toEqual(['comment', 'edit'])
    for (const r of rows) {
      expect(r.origin).toBe('manual')
      expect(r.owned_capabilities, 'a built-in row never exceeds its single capability').toEqual([r.builtin_capability])
    }
    expect(await check(fgaClient, p, 'edit', { type: 'page', id: pageId })).toBe(true)
    expect(await check(fgaClient, p, 'comment', { type: 'page', id: pageId })).toBe(true)
    // revoke the edit arm — comment stays (the independence this ticket exists for)
    await revokeSpaceAccess(db, fgaClient, app.searchDriver, { spaceId, tenantId: TENANT, userId: OWNER, grantee: p, capability: 'edit', plan: 'business' })
    expect((await rowsOf(p)).map((r) => r.builtin_capability)).toEqual(['comment'])
    expect(await check(fgaClient, p, 'edit', { type: 'page', id: pageId })).toBe(false)
    expect(await check(fgaClient, p, 'comment', { type: 'page', id: pageId }), 'comment survives the edit revoke').toBe(true)
  }, 120_000)

  it('is idempotent per arm: a duplicate composite leaves two rows; a half-held principal lands the other arm', async () => {
    const p = sub('idem')
    await grantSpaceAccess(db, fgaClient, app.searchDriver, { spaceId, tenantId: TENANT, userId: OWNER, grantee: p, capability: 'comment', plan: 'business' })
    await composite(p, ['edit', 'comment'])
    expect((await rowsOf(p)).map((r) => r.builtin_capability)).toEqual(['comment', 'edit'])
    await composite(p, ['edit', 'comment']) // full duplicate
    expect((await rowsOf(p)).map((r) => r.builtin_capability), 'still exactly two rows').toEqual(['comment', 'edit'])
  }, 120_000)

  it('the bare capability form grants exactly what it says (one row, no comment ride-along)', async () => {
    const p = sub('bare')
    const res = await app.inject({
      method: 'POST', url: `/spaces/${spaceId}/access`, headers: dev,
      payload: { grantee: p, relation: 'edit' },
    })
    expect(res.statusCode).toBe(204)
    expect((await rowsOf(p)).map((r) => r.builtin_capability), 'one row, edit only — the honest API').toEqual(['edit'])
  }, 120_000)

  it('the composite REPLACES the principal\'s other role (the #536 sweep keeps both arms)', async () => {
    const p = sub('sweep')
    await grantSpaceAccess(db, fgaClient, app.searchDriver, { spaceId, tenantId: TENANT, userId: OWNER, grantee: p, capability: 'view', plan: 'business' })
    const res = await app.inject({
      method: 'POST', url: `/spaces/${spaceId}/access`, headers: dev,
      payload: { grantee: p, relations: ['edit', 'comment'] },
    })
    expect(res.statusCode).toBe(204)
    const rows = await rowsOf(p)
    expect(rows.map((r) => r.builtin_capability), 'view replaced; BOTH arms kept').toEqual(['comment', 'edit'])
  }, 120_000)

  it('one composite add audits one event per arm (two precise records, ADR-199 ruling)', async () => {
    const p = sub('audit')
    const count = async () => Number((await adminPool<{ n: string }[]>`
      SELECT (SELECT count(*) FROM audit_log    WHERE tenant_id = ${TENANT} AND action = 'space.access_granted' AND target = ${`space:${spaceId}`})
           + (SELECT count(*) FROM audit_outbox WHERE tenant_id = ${TENANT} AND action = 'space.access_granted' AND target = ${`space:${spaceId}`}) AS n`)[0]!.n)
    const before = await count()
    await composite(p, ['edit', 'comment'])
    expect((await count()) - before, 'two audit events for one noun add').toBe(2)
  }, 120_000)
})
