// External-embed route GET /pages/:pageId/embed (#108 / ADR-071). Integration: the deny gates that
// require no network — a viewer with the default-EMPTY provider allowlist is denied (403, no fetch),
// a missing url is 400. The page-view-gate denial + the allowed fetch path are covered by the
// resolveEmbed unit test (embed-resolve.test) with a stub fetcher.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import type { FastifyInstance } from 'fastify'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { fgaClient, deleteObjectTuples } from '@wikistead/authz'
import { LogicalSearchDriver } from '../search/index.js'
import { createSpace, deleteSpace } from '../routes/spaces.js'
import { createPage } from '../routes/pages.js'
import { buildApp } from '../app.js'
import type { Tenant } from '@wikistead/types'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const driver = new LogicalSearchDriver()
const HOST = 'dev.localhost'
const TENANT = 'tenant_dev'
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'free', isolation: 'logical' }) as Tenant
let db: TenantDb, app: FastifyInstance, spaceId: string, pageId: string

beforeAll(async () => {
  await driver.ensureIndex()
  db = await acquireTenantDb(asTenant(TENANT))
  app = await buildApp(); await app.ready()
  spaceId = (await createSpace(db, fgaClient, { tenantId: TENANT, userId: 'dev-user', plan: 'free', name: `embed-sp-${Date.now().toString(36)}` })).id
  pageId = (await createPage(db, fgaClient, driver, { tenantId: TENANT, spaceId, userId: 'dev-user', title: 'embed-pg' })).id
  await admin`UPDATE tenant_settings SET embed_providers = '{}' WHERE tenant_id = ${TENANT}`.catch(() => {})
}, 30_000)
afterAll(async () => {
  await deleteObjectTuples(fgaClient, `page:${pageId}`).catch(() => {})
  await admin`DELETE FROM search_outbox WHERE page_id = ${pageId}`.catch(() => {})
  await admin`DELETE FROM pages WHERE id = ${pageId}`.catch(() => {})
  await deleteSpace(db, fgaClient, driver, { tenantId: TENANT, spaceId, userId: 'dev-user' }).catch(() => {})
  await db.release(); await admin.end(); await pool.end()
}, 30_000)

const embed = (url?: string) =>
  app.inject({ method: 'GET', url: `/pages/${pageId}/embed${url ? `?url=${encodeURIComponent(url)}` : ''}`, headers: { host: HOST, authorization: 'Bearer dev-token' } })

describe('GET /pages/:pageId/embed (#108 / ADR-071)', () => {
  it('a viewer with the default-empty allowlist is denied (403) — no provider opted in', async () => {
    const res = await embed('https://embed.example.com/x')
    expect(res.statusCode).toBe(403) // page-view passes (dev-user created it) but no allowlisted provider
  })

  it('a missing url is 400', async () => {
    expect((await embed()).statusCode).toBe(400)
  })
})
