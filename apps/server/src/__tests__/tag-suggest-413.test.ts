// #413 / ADR-145 §5: viewer-scoped tag suggestions. The leak class under test: a tag name used ONLY on
// pages the caller cannot view must never be suggested (the tag string itself is an existence leak — the
// autocomplete must not reveal what invisible pages are about). A tag is offered only when ≥1 of its pages
// is FGA-view-confirmed. Published-only; member-only route (guest 401). Real Postgres + OpenFGA.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { mintGuestToken } from '@wikistead/auth'
import { pool } from '../db/pool.js'
import { TenantRegistry } from '../db/registry.js'
import { acquireTenantDb } from '../db/tenant-db.js'
import type { TenantDb } from '../db/index.js'
import { fgaClient, writeTuples, deleteTuples } from '@wikistead/authz'
import { LogicalSearchDriver } from '../search/index.js'
import { createSpace, deleteSpace } from '../routes/spaces.js'
import { createPage, deletePage, syncPageTags, getSuggestedTags } from '../routes/pages.js'
import { buildApp } from '../app.js'
import type { Tenant } from '@wikistead/types'

const driver = new LogicalSearchDriver()
const adminPool = postgres(process.env.DATABASE_ADMIN_URL!)

let tenant: Tenant
let db: TenantDb
let spaceId: string
const ids: string[] = []
let openPage!: string    // tags: [sug-shared, sug-open] — viewable by LIMITED
let secretPage!: string  // tags: [sug-shared, sug-secret] — NOT viewable by LIMITED
let draftPage!: string   // never published — its tags never enter the projection
const LIMITED = 'user:suggest-limited-413'

const fm = (tags: string) => `---\ntags: ${tags}\n---\n\nbody\n`

async function mkPage(title: string, md: string | null): Promise<string> {
  const p = await createPage(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user', title })
  ids.push(p.id)
  if (md !== null) {
    await adminPool`UPDATE pages SET published_md = ${md}, published_at = now() WHERE id = ${p.id}`
    await db.tx(async (tx) => syncPageTags(tx, tenant.id, p.id, md))
  }
  return p.id
}

beforeAll(async () => {
  const registry = new TenantRegistry(pool)
  tenant = (await registry.findBySlug('dev'))!
  db = await acquireTenantDb(tenant)
  const space = await createSpace(db, fgaClient, { tenantId: tenant.id, userId: 'dev-user', plan: tenant.plan, name: 'suggest-space' })
  spaceId = space.id
  openPage = await mkPage('Open Page', fm('[sug-shared, Sug-Open]'))
  secretPage = await mkPage('Secret Page', fm('[sug-shared, sug-secret]'))
  draftPage = await mkPage('Draft Page', null)
  await writeTuples(fgaClient, [{ user: LIMITED, relation: 'view_direct', object: `page:${openPage}` }])
}, 60_000)

afterAll(async () => {
  await deleteTuples(fgaClient, [{ user: LIMITED, relation: 'view_direct', object: `page:${openPage}` }]).catch(() => {})
  for (const id of ids) await deletePage(db, fgaClient, driver, { pageId: id, userId: 'dev-user' }).catch(() => {})
  await deleteSpace(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user' }).catch(() => {})
  await db.release()
  await pool.end()
  await adminPool.end()
}, 60_000)

describe('getSuggestedTags (#413 / ADR-145 §5)', () => {
  it('suggests tags by prefix (case-insensitive), keeping the first-seen display casing', async () => {
    const s = await getSuggestedTags(db, fgaClient, { q: 'sug-o', subject: 'user:dev-user' })
    expect(s.map((t) => t.tag)).toContain('sug-open')
    expect(s.find((t) => t.tag === 'sug-open')?.display).toBe('Sug-Open')
  })

  it('ANTI-TEST (the leak): a tag used ONLY on unviewable pages is NOT suggested to that viewer', async () => {
    const s = await getSuggestedTags(db, fgaClient, { q: 'sug-', subject: LIMITED })
    const tags = s.map((t) => t.tag)
    expect(tags).toContain('sug-shared') // carried by the viewable openPage too → offered
    expect(tags).toContain('sug-open')
    expect(tags).not.toContain('sug-secret') // ONLY on secretPage → the tag name itself must not leak
  })

  it('the creator (sees everything) gets all three sug- tags', async () => {
    const s = await getSuggestedTags(db, fgaClient, { q: 'sug-', subject: 'user:dev-user' })
    const tags = s.map((t) => t.tag)
    expect(tags).toEqual(expect.arrayContaining(['sug-shared', 'sug-open', 'sug-secret']))
  })

  it('a LIKE metacharacter in the query is literal (no wildcard injection)', async () => {
    const s = await getSuggestedTags(db, fgaClient, { q: '%', subject: 'user:dev-user' })
    expect(s.map((t) => t.tag)).not.toContain('sug-shared') // '%' must not match everything
  })

  it('an unknown prefix yields an empty list', async () => {
    expect(await getSuggestedTags(db, fgaClient, { q: 'zz-no-such-prefix', subject: 'user:dev-user' })).toEqual([])
  })
})

describe('GET /tags/suggest route (#413 — members only)', () => {
  let app: FastifyInstance
  let guestTok: string
  beforeAll(async () => {
    app = await buildApp()
    await app.ready()
    guestTok = await mintGuestToken({ secret: process.env.GUEST_TOKEN_SECRET!, ttlSeconds: 300 }, { tenantId: 'tenant_dev', shareLinkId: 'demo_view_perm', resource: { type: 'page', id: 'demo' }, capability: 'view' })
  }, 30_000)
  afterAll(async () => { await app.close() }, 30_000)

  it('a member gets suggestions (200, array)', async () => {
    const res = await app.inject({ method: 'GET', url: '/tags/suggest?q=', headers: { host: 'dev.localhost', authorization: 'Bearer dev-token' } })
    expect(res.statusCode).toBe(200)
    expect(Array.isArray(res.json())).toBe(true)
  })

  it('ANTI-TEST: a share_link (guest) token is REJECTED (tag names are member content)', async () => {
    const res = await app.inject({ method: 'GET', url: '/tags/suggest?q=a', headers: { host: 'dev.localhost', authorization: `Bearer ${guestTok}` } })
    expect(res.statusCode).toBeGreaterThanOrEqual(401)
    expect(res.statusCode).toBeLessThan(500)
    expect(res.statusCode).not.toBe(200)
  })
})
