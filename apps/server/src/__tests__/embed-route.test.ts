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

describe('GET /embed/providers (#108 / ADR-071 comment 551 — client iframe allowlist)', () => {
  const providers = () => app.inject({ method: 'GET', url: '/embed/providers', headers: { host: HOST } })

  // Upsert (not UPDATE): the tenant_settings row may not exist yet when this file runs in the full
  // suite — an UPDATE would affect 0 rows and the read would fall back to the default [].
  const setProviders = (hosts: string[]) =>
    admin`INSERT INTO tenant_settings (tenant_id, embed_providers) VALUES (${TENANT}, ${admin.array(hosts)})
          ON CONFLICT (tenant_id) DO UPDATE SET embed_providers = ${admin.array(hosts)}`

  it('returns the empty allowlist by default (external embed off, opt-in)', async () => {
    await setProviders([])
    const res = await providers()
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ providers: [] })
  })

  it('returns the operator-configured allowlisted hosts', async () => {
    await setProviders(['youtube.com', 'player.vimeo.com'])
    try {
      const res = await providers()
      expect(res.statusCode).toBe(200)
      expect(res.json().providers).toEqual(['youtube.com', 'player.vimeo.com'])
    } finally {
      await setProviders([])
    }
  })
})

describe('POST /pages/:pageId/plantuml/render (#140 / ADR-074)', () => {
  const render = (source?: string) =>
    app.inject({
      method: 'POST', url: `/pages/${pageId}/plantuml/render`,
      headers: { host: HOST, authorization: 'Bearer dev-token', 'content-type': 'application/json' },
      payload: JSON.stringify(source !== undefined ? { source } : {}),
    })

  it('degrades to 204 when no render endpoint is configured (operator opt-in not taken)', async () => {
    delete process.env.PLANTUML_RENDER_URL // ensure unconfigured
    const res = await render('@startuml\nA->B\n@enduml')
    expect(res.statusCode).toBe(204) // caller renders the source fence
  })

  it('rejects an empty source (400)', async () => {
    expect((await render('   ')).statusCode).toBe(400)
    expect((await render()).statusCode).toBe(400)
  })
})

describe('GET /pages/:pageId/transclude/:refId (#108 / ADR-071)', () => {
  const transclude = (refId: string) =>
    app.inject({ method: 'GET', url: `/pages/${pageId}/transclude/${refId}`, headers: { host: HOST, authorization: 'Bearer dev-token' } })

  it('a non-existent ref → 403 (existence-hiding placeholder, no oracle)', async () => {
    const res = await transclude('does-not-exist-xyz')
    expect(res.statusCode).toBe(403) // absent is indistinguishable from unviewable
  })

  it('an UNPUBLISHED but viewable ref → the SAME 403 (no published content ≠ leak)', async () => {
    // dev-user can view pageId (creator) but it has no published_md → still the uniform 403, so a
    // viewer can't tell "exists-but-unpublished" from "denied"/"absent".
    const res = await transclude(pageId)
    expect(res.statusCode).toBe(403)
  })
})
