// Integration test — real Postgres + OpenFGA + Meilisearch + Fastify, no mocks.
// 2f-3 guest HTTP path (security-critical). The load-bearing authz boundaries:
//   - a VIEW share token can read published content but CANNOT publish,
//   - an EDIT share token can publish (attributed to guest:<shareLinkId>),
//   - JWT asserts intent, OpenFGA asserts authority: a view link has no edit tuple
//     so publishPage is denied even bypassing the hook; a REVOKED link is denied,
//   - resource binding: a token for page A cannot read/publish page B,
//   - cross-tenant tokens are rejected, and a guest token cannot reach a
//     member-only route.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import * as Y from 'yjs'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { fgaClient, deleteObjectTuples } from '@wikistead/authz'
import { mintGuestToken } from '@wikistead/auth'
import { createSpace } from '../routes/spaces.js'
import { createPage, publishPage } from '../routes/pages.js'
import { buildApp } from '../app.js'
import type { Tenant } from '@wikistead/types'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const TENANT = 'tenant_dev'
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'free', isolation: 'logical' }) as Tenant
const guestCfg = { secret: process.env.GUEST_TOKEN_SECRET!, ttlSeconds: 3600 }
const WORD = `guestbody${Date.now().toString(36)}`
const ydoc = (text: string) => Buffer.from(Y.encodeStateAsUpdate((() => { const d = new Y.Doc(); d.getText('content').insert(0, text); return d })()))

let app: FastifyInstance
let db: TenantDb
let spaceId: string, pageA: string, pageB: string, viewLinkId: string, editLinkId: string, viewTok: string, editTok: string
const attA = `gpatta${Date.now().toString(36)}` // attachment on pageA
const attB = `gpattb${Date.now().toString(36)}` // attachment on pageB

const dev = { host: 'dev.localhost', authorization: 'Bearer dev-token', 'content-type': 'application/json' }
const guestGet = (token: string, pageId: string) =>
  app.inject({ method: 'GET', url: `/pages/${pageId}/published`, headers: { host: 'dev.localhost', authorization: `Bearer ${token}` } })
const guestPublish = (token: string, pageId: string) =>
  app.inject({ method: 'POST', url: `/pages/${pageId}/publish`, headers: { host: 'dev.localhost', authorization: `Bearer ${token}` } })
const download = (token: string, attId: string) =>
  app.inject({ method: 'GET', url: `/attachments/${attId}/download`, headers: { host: 'dev.localhost', authorization: `Bearer ${token}` } })

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
  db = await acquireTenantDb(asTenant(TENANT))
  spaceId = (await createSpace(db, fgaClient, { tenantId: TENANT, userId: 'dev-user', plan: 'free', name: 'guest-pub-space' })).id
  pageA = (await createPage(db, fgaClient, app.searchDriver, { tenantId: TENANT, spaceId, userId: 'dev-user', title: 'Guest A' })).id
  pageB = (await createPage(db, fgaClient, app.searchDriver, { tenantId: TENANT, spaceId, userId: 'dev-user', title: 'Guest B' })).id
  await admin`UPDATE pages SET ydoc = ${ydoc(`# A\n\n${WORD} body\n`)} WHERE id = ${pageA}`
  // A confirmed attachment on each page (no bytes needed: presignGet returns a URL
  // regardless; the test asserts the AUTHORIZATION before issuing it).
  await admin`INSERT INTO attachments (id, tenant_id, page_id, filename, content_type, s3_key, status, size_bytes, confirmed_at) VALUES
    (${attA}, ${TENANT}, ${pageA}, 'a.png', 'image/png', ${`${TENANT}/gp/${attA}.png`}, 'confirmed', 1, now()),
    (${attB}, ${TENANT}, ${pageB}, 'b.png', 'image/png', ${`${TENANT}/gp/${attB}.png`}, 'confirmed', 1, now())
    ON CONFLICT (id) DO NOTHING`

  const mk = async (capability: 'view' | 'edit') => {
    const r = await app.inject({ method: 'POST', url: '/share-links', headers: dev, payload: { resource: { type: 'page', id: pageA }, capability, expiresInSeconds: null } })
    return (r.json() as { id: string }).id
  }
  viewLinkId = await mk('view')
  editLinkId = await mk('edit')
  viewTok = await mintGuestToken(guestCfg, { tenantId: TENANT, shareLinkId: viewLinkId, resource: { type: 'page', id: pageA }, capability: 'view' })
  editTok = await mintGuestToken(guestCfg, { tenantId: TENANT, shareLinkId: editLinkId, resource: { type: 'page', id: pageA }, capability: 'edit' })
}, 30_000)

afterAll(async () => {
  await app.searchDriver.deleteDoc(pageA).catch(() => {})
  await app.searchDriver.deleteDoc(pageB).catch(() => {})
  await deleteObjectTuples(fgaClient, `page:${pageA}`).catch(() => {})
  await deleteObjectTuples(fgaClient, `page:${pageB}`).catch(() => {})
  await admin`DELETE FROM attachments WHERE id IN (${attA}, ${attB})`.catch(() => {})
  await admin`DELETE FROM share_links WHERE resource_id = ${pageA}`.catch(() => {})
  await admin`DELETE FROM revisions WHERE page_id = ${pageA}`.catch(() => {})
  await admin`DELETE FROM search_outbox WHERE page_id IN (${pageA}, ${pageB})`.catch(() => {})
  await admin`DELETE FROM pages WHERE id IN (${pageA}, ${pageB})`.catch(() => {})
  await admin`DELETE FROM spaces WHERE id = ${spaceId}`.catch(() => {})
  await db.release()
  await app.close()
  await admin.end()
  await pool.end()
}, 30_000)

describe('guest HTTP path: published read + publish authorization', () => {
  it('a VIEW token can read published but CANNOT publish (hook rejects → 401)', async () => {
    expect((await guestGet(viewTok, pageA)).statusCode).toBe(200)
    expect((await guestPublish(viewTok, pageA)).statusCode).toBe(401) // route needs guest:'edit'
  })

  it('FGA authority: a view link has no edit tuple — publishPage denied even past the hook', async () => {
    await expect(publishPage(db, fgaClient, app.searchDriver, {
      pageId: pageA, subject: `share_link:${viewLinkId}`, createdBy: `guest:${viewLinkId}`,
      context: { current_time: new Date().toISOString() },
    })).rejects.toMatchObject({ statusCode: 403 })
  })

  it('an EDIT token publishes — attributed to guest:<shareLinkId>; view then sees the content', async () => {
    expect((await guestPublish(editTok, pageA)).statusCode).toBe(200)
    const [{ created_by }] = await admin<[{ created_by: string }]>`SELECT created_by FROM revisions WHERE page_id = ${pageA} ORDER BY created_at DESC LIMIT 1`
    expect(created_by).toBe(`guest:${editLinkId}`)
    const body = (await guestGet(viewTok, pageA)).json() as { publishedMd: string | null }
    expect(body.publishedMd).toContain(WORD)
  })

  it('resource binding: a token for page A cannot read/publish page B', async () => {
    expect((await guestGet(viewTok, pageB)).statusCode).toBe(403)
    expect((await guestPublish(editTok, pageB)).statusCode).toBe(403)
  })

  // ── internal-resource (image) resolution: page-view gated, guest principal ──
  it('a VIEW token resolves an image on its OWN page (presign issued after FGA view)', async () => {
    const r = await download(viewTok, attA)
    expect(r.statusCode).toBe(200)
    expect((r.json() as { downloadUrl: string }).downloadUrl).toMatch(/^https?:\/\//)
  })

  it('a guest token CANNOT resolve an image on a different page (FGA falls naturally — tuple is the bind)', async () => {
    expect((await download(viewTok, attB)).statusCode).toBe(403)
  })

  it('a cross-tenant guest token is rejected for image download (401 at the hook)', async () => {
    const forged = await mintGuestToken(guestCfg, { tenantId: 'tenant_acme', shareLinkId: 'x', resource: { type: 'page', id: pageA }, capability: 'view' })
    expect((await download(forged, attA)).statusCode).toBe(401)
  })

  it('members resolve images unchanged', async () => {
    expect((await download('dev-token', attA)).statusCode).toBe(200)
  })

  it('revoked link: published read, publish, AND image download are all denied (FGA authority)', async () => {
    const devNoBody = { host: 'dev.localhost', authorization: 'Bearer dev-token' } // no content-type (empty DELETE body)
    expect((await app.inject({ method: 'DELETE', url: `/share-links/${editLinkId}`, headers: devNoBody })).statusCode).toBe(204)
    expect((await app.inject({ method: 'DELETE', url: `/share-links/${viewLinkId}`, headers: devNoBody })).statusCode).toBe(204)
    expect((await guestPublish(editTok, pageA)).statusCode).toBe(403)
    expect((await guestGet(viewTok, pageA)).statusCode).toBe(403)
    expect((await download(viewTok, attA)).statusCode).toBe(403) // a NEW download request after revoke is denied
  })

  it('a cross-tenant guest token is rejected (401)', async () => {
    const forged = await mintGuestToken(guestCfg, { tenantId: 'tenant_acme', shareLinkId: 'x', resource: { type: 'page', id: pageA }, capability: 'view' })
    expect((await guestGet(forged, pageA)).statusCode).toBe(401)
  })

  it('a guest token cannot reach a member-only route (401)', async () => {
    const r = await app.inject({ method: 'POST', url: '/spaces', headers: { host: 'dev.localhost', authorization: `Bearer ${editTok}`, 'content-type': 'application/json' }, payload: { name: 'nope' } })
    expect(r.statusCode).toBe(401)
  })
})
