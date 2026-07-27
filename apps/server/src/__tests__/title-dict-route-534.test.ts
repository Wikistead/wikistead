// #534 (design review, blocker 2): the dictionary is cached per viewer, so the pins that matter most are
// the ones the HTTP route can fail — a unit test of the cache module cannot notice the cache being read
// BEFORE the anchor's view gate. Moving the cache read above that gate leaves the module tests green and
// turns a 404 into a 200, which is the disclosure this file exists to prevent.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { pool } from '../db/pool.js'
import { TenantRegistry } from '../db/registry.js'
import { acquireTenantDb } from '../db/tenant-db.js'
import type { TenantDb } from '../db/index.js'
import { fgaClient } from '@wikistead/authz'
import { LogicalSearchDriver } from '../search/index.js'
import { createSpace, deleteSpace } from '../routes/spaces.js'
import { createPage, deletePage, publishPage } from '../routes/pages.js'
import { buildApp } from '../app.js'
import { clearTitleDictCache } from '../title-dict-cache.js'
import type { Tenant } from '@wikistead/types'

const driver = new LogicalSearchDriver()
const H = { host: 'dev.localhost', authorization: 'Bearer dev-token' }
const tag = Date.now().toString(36)

let app: FastifyInstance
let tenant: Tenant
let db: TenantDb
let spaceId: string
let pageId: string

beforeAll(async () => {
  tenant = (await new TenantRegistry(pool).findBySlug('dev'))!
  db = await acquireTenantDb(tenant)
  app = await buildApp()
  await app.ready()
  spaceId = (await createSpace(db, fgaClient, { tenantId: tenant.id, userId: 'dev-user', plan: tenant.plan, name: `dict534-${tag}` })).id
  const p = await createPage(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user', title: `dict534 page ${tag}` })
  pageId = p.id
  await publishPage(db, fgaClient, driver, { putObject: async () => {}, getObject: async () => Buffer.alloc(0) } as never, {
    pageId, subject: 'user:dev-user', createdBy: 'user:dev-user',
  })
}, 60_000)

afterAll(async () => {
  await deletePage(db, fgaClient, driver, { pageId, userId: 'dev-user' }).catch(() => {})
  await deleteSpace(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user' }).catch(() => {})
  await app?.close()
  await db.release()
  await pool.end()
}, 60_000)

const get = (id: string) => app.inject({ method: 'GET', url: `/pages/${id}/title-dictionary`, headers: H })

describe('#534 the cached dictionary route', () => {
  beforeEach(() => clearTitleDictCache())

  it('answers, and answers again from the cache with the same content', async () => {
    const first = await get(pageId)
    expect(first.statusCode).toBe(200)
    const second = await get(pageId)
    expect(second.statusCode).toBe(200)
    expect(second.json().entries.length, 'the warm answer is the same dictionary').toBe(first.json().entries.length)
    expect(first.json().entries.some((e: { title: string }) => e.title.includes(tag))).toBe(true)
  }, 120_000)

  it('a WARM cache does not let an unviewable anchor through — the gate runs first', async () => {
    await get(pageId) // warm this viewer's entry
    // a page id that does not exist is indistinguishable from one the caller may not view (#262)
    const res = await get('00000000-0000-4000-8000-000000000000')
    expect(res.statusCode, 'still 404 with a hot cache — the anchor gate is not behind it').toBe(404)
    expect(res.json().error, 'and it says nothing beyond "not found"').toBe('not found')
  }, 120_000)

  it('a malformed anchor id is refused the same way, warm or cold', async () => {
    await get(pageId)
    const res = await get('not-a-uuid')
    expect([400, 404], 'never a 200 from someone else cached dictionary').toContain(res.statusCode)
  }, 120_000)
})
