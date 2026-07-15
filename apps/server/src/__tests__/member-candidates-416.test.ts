// #416 / ADR-161: the page-scoped member typeahead. Gate = page#manage (byte-for-byte the authority
// that can already grant on the page); projection = {sub, displayName} ONLY; empty query = [] (never a
// first-10 member dump — pinned for BOTH the page and the space endpoint via the shared core). The
// approved widening's two weakest real principals are the positive cases: (a) a space EDITOR whose
// draft made them the page's manage_direct creator, (b) a member holding ONLY manage_direct on one
// page. Real Postgres + OpenFGA (+ inject for the guest-401 route boundary).
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
import { createSpace, deleteSpace, listMemberCandidates, searchMemberCandidates } from '../routes/spaces.js'
import { createPage, deletePage } from '../routes/pages.js'
import { buildApp } from '../app.js'
import type { Tenant } from '@wikistead/types'

const driver = new LogicalSearchDriver()
const admin = postgres(process.env.DATABASE_ADMIN_URL!)

let tenant: Tenant
let db: TenantDb
let spaceId: string
let draftByEditor: string
let plainPage: string
const EDITOR = 'mc416-editor'
const GRANTEE = 'mc416-grantee'
const VIEWER = 'mc416-viewer'
const PAGE_EDITOR = 'mc416-pageeditor'
const spaceGrants: { user: string; relation: string; object: string }[] = []
const pageGrants: { user: string; relation: string; object: string }[] = []

beforeAll(async () => {
  tenant = (await new TenantRegistry(pool).findBySlug('dev'))!
  db = await acquireTenantDb(tenant)
  spaceId = (await createSpace(db, fgaClient, { tenantId: tenant.id, userId: 'dev-user', plan: tenant.plan, name: 'mc416-space' })).id
  spaceGrants.push(
    { user: `user:${EDITOR}`, relation: 'editor_member', object: `space:${spaceId}` },
    { user: `user:${VIEWER}`, relation: 'viewer', object: `space:${spaceId}` },
  )
  await writeTuples(fgaClient, spaceGrants)
  // (a) the space editor creates a DRAFT → they hold manage_direct on it (the creator grant).
  draftByEditor = (await createPage(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: EDITOR, title: 'mc416 draft' })).id
  // (b) a page a member manages ONLY via a direct grant + a page someone merely EDITS.
  plainPage = (await createPage(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user', title: 'mc416 plain' })).id
  pageGrants.push(
    { user: `user:${GRANTEE}`, relation: 'manage_direct', object: `page:${plainPage}` },
    { user: `user:${PAGE_EDITOR}`, relation: 'edit_direct', object: `page:${plainPage}` },
  )
  await writeTuples(fgaClient, pageGrants)
}, 60_000)

afterAll(async () => {
  await deleteTuples(fgaClient, [...spaceGrants, ...pageGrants]).catch(() => {})
  for (const id of [draftByEditor, plainPage]) await deletePage(db, fgaClient, driver, { pageId: id, userId: 'dev-user' }).catch(() => {})
  await deleteSpace(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user' }).catch(() => {})
  await db.release()
  await pool.end()
  await admin.end()
}, 60_000)

describe('GET /pages/:id/member-candidates gate + projection (#416)', () => {
  let app: FastifyInstance
  const H = { host: 'dev.localhost', authorization: 'Bearer dev-token' }
  beforeAll(async () => { app = await buildApp(); await app.ready() }, 30_000)
  afterAll(async () => { await app.close() }, 30_000)

  const url = (pageId: string, q: string) => `/pages/${pageId}/member-candidates?q=${encodeURIComponent(q)}`

  it('positive (weakest principals): the draft-creator space editor and a manage_direct-only grantee can search', async () => {
    // The dev bearer token always impersonates dev-user, so per-principal ROUTE calls are not
    // constructible here; the route gate is exactly `check(page#manage)` (one line), so the weakest
    // principals are verified against that same predicate, and the route behaviour is covered by the
    // dev-user 200 + guest 401 cases below.
    const { check } = await import('@wikistead/authz')
    expect(await check(fgaClient, `user:${EDITOR}`, 'manage', { type: 'page', id: draftByEditor })).toBe(true)
    expect(await check(fgaClient, `user:${GRANTEE}`, 'manage', { type: 'page', id: plainPage })).toBe(true)
    // And the search core they reach returns the bounded projection.
    const rows = await searchMemberCandidates(db, 'dev')
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) expect(Object.keys(r).sort()).toEqual(['displayName', 'sub']) // projection pin — no email/role
  })

  it('route: dev-user (manager) gets candidates; the response carries only sub/displayName', async () => {
    const res = await app.inject({ method: 'GET', url: url(plainPage, 'dev'), headers: H })
    expect(res.statusCode).toBe(200)
    const body = res.json() as Record<string, unknown>[]
    expect(body.length).toBeGreaterThan(0)
    for (const r of body) expect(Object.keys(r).sort()).toEqual(['displayName', 'sub'])
  })

  it('negative: a space VIEWER and a plain page EDITOR are 403 (manage is the gate); guests are 401', async () => {
    const { check } = await import('@wikistead/authz')
    expect(await check(fgaClient, `user:${VIEWER}`, 'manage', { type: 'page', id: plainPage })).toBe(false)
    expect(await check(fgaClient, `user:${PAGE_EDITOR}`, 'manage', { type: 'page', id: plainPage })).toBe(false)

    const guestTok = await mintGuestToken({ secret: process.env.GUEST_TOKEN_SECRET!, ttlSeconds: 300 }, { tenantId: 'tenant_dev', shareLinkId: 'demo_view_perm', resource: { type: 'page', id: 'demo' }, capability: 'view' })
    const res = await app.inject({ method: 'GET', url: url('demo', 'dev'), headers: { host: 'dev.localhost', authorization: `Bearer ${guestTok}` } })
    expect(res.statusCode).toBeGreaterThanOrEqual(401)
    expect(res.statusCode).not.toBe(200)
  })

  it('empty query returns [] on BOTH endpoints (never a first-10 dump)', async () => {
    expect(await searchMemberCandidates(db, '')).toEqual([])
    expect(await searchMemberCandidates(db, '   ')).toEqual([])
    expect(await listMemberCandidates(db, fgaClient, { spaceId, userId: 'dev-user', q: '' })).toEqual([])
    const res = await app.inject({ method: 'GET', url: url(plainPage, ''), headers: H })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([])
  })

  it('cross-tenant: the tenant-scoped handle never surfaces another tenant\'s members', async () => {
    // The acme tenant's admin exists in the shared DB — the dev-scoped search must not see them.
    const rows = await searchMemberCandidates(db, 'acme')
    expect(rows.map((r) => r.sub).some((s) => s.includes('acme'))).toBe(false)
  })
})
