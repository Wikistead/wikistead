// #274 / ADR-135 §3-§4: anonymous guest page CREATION (atomic create-publish) + guest attachment caps.
// Integration over the real stack (Postgres + OpenFGA + Valkey + S3 + Fastify, no mocks). Load-bearing
// boundaries under test:
//   - a space-EDIT-link guest creates a page that is PUBLISHED from birth (page#space + the published
//     marker pair + a revision, one operation) and can then edit it (edit_from_space);
//   - attribution is the #331 anon session id — never a member sub;
//   - a VIEW space link and a PAGE edit link can NOT create (FGA is the only gate, uniform 403);
//   - member-only seeds (templateId/fromPageId) are structurally ignored on the guest branch;
//   - the created-page cap 429s with a STATIC reason code (two-bucket, migration 068);
//   - guest attachment presign/confirm work on the guest's page, with the count cap (429 at presign)
//     and the per-file size cap (413 at confirm, row + object dropped).
// The shared tenant's caps are ALWAYS reset in afterEach (fixed-window buckets are per-link/session ids
// minted fresh per test, so windows never bleed across tests).
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
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
const dev = { host: 'dev.localhost', authorization: 'Bearer dev-token', 'content-type': 'application/json' }

let app: FastifyInstance
let db: TenantDb
let spaceId: string
let seedPageId: string // a published member page (the page-link anti-test target)
const createdPages: string[] = []

const resetCaps = () => admin`
  UPDATE tenant_settings SET abuse_create_page_link_max = NULL, abuse_create_page_session_max = NULL,
    abuse_attach_count_link_max = NULL, abuse_attach_count_session_max = NULL, abuse_attach_guest_max_bytes = NULL
  WHERE tenant_id = ${TENANT}`

async function mkSpaceLink(capability: 'view' | 'edit'): Promise<string> {
  const r = await app.inject({ method: 'POST', url: '/share-links', headers: dev, payload: { resource: { type: 'space', id: spaceId }, capability, expiresInSeconds: null } })
  expect(r.statusCode, r.body).toBe(201)
  return (r.json() as { id: string }).id
}
const mkSpaceTok = (linkId: string, capability: 'view' | 'edit', anonId: string) =>
  mintGuestToken(guestCfg, { tenantId: TENANT, shareLinkId: linkId, resource: { type: 'space', id: spaceId }, capability, anonId })
let seq = 0
const anon = () => `anon:${(Date.now() + seq++).toString(16).slice(-12).padStart(12, '0')}`
const guestHeaders = (token: string) => ({ host: 'dev.localhost', authorization: `Bearer ${token}`, 'content-type': 'application/json' })
const createAsGuest = (token: string, body: Record<string, unknown> = {}) =>
  app.inject({ method: 'POST', url: `/spaces/${spaceId}/pages`, headers: guestHeaders(token), payload: { title: 'guest page', ...body } })

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
  await admin`INSERT INTO tenant_settings (tenant_id) VALUES (${TENANT}) ON CONFLICT (tenant_id) DO NOTHING`
  await resetCaps()
  db = await acquireTenantDb(asTenant(TENANT))
  spaceId = (await createSpace(db, fgaClient, { tenantId: TENANT, userId: 'dev-user', plan: 'free', name: `gcp274-${Date.now().toString(36)}` })).id
  seedPageId = (await createPage(db, fgaClient, app.searchDriver, { tenantId: TENANT, spaceId, userId: 'dev-user', title: 'seed' })).id
  await publishPage(db, fgaClient, app.searchDriver, app.storageDriver, { pageId: seedPageId, subject: 'user:dev-user', createdBy: 'user:dev-user' })
}, 30_000)

afterEach(async () => { await resetCaps() })

afterAll(async () => {
  await resetCaps()
  for (const id of [...createdPages, seedPageId]) {
    await app.searchDriver.deleteDoc(id).catch(() => {})
    await deleteObjectTuples(fgaClient, `page:${id}`).catch(() => {})
    await admin`DELETE FROM attachments WHERE page_id = ${id}`.catch(() => {})
    await admin`DELETE FROM revisions WHERE page_id = ${id}`.catch(() => {})
    await admin`DELETE FROM search_outbox WHERE page_id = ${id}`.catch(() => {})
    await admin`DELETE FROM notifications WHERE event_id IN (SELECT id FROM feed_events WHERE page_id = ${id})`.catch(() => {})
    await admin`DELETE FROM feed_events WHERE page_id = ${id}`.catch(() => {})
    await admin`DELETE FROM pages WHERE id = ${id}`.catch(() => {})
  }
  await admin`DELETE FROM share_links WHERE resource_id = ${spaceId} OR resource_id = ${seedPageId}`.catch(() => {})
  await deleteObjectTuples(fgaClient, `space:${spaceId}`).catch(() => {})
  await admin`DELETE FROM spaces WHERE id = ${spaceId}`.catch(() => {})
  await db.release()
  await app.close()
  await admin.end()
  await pool.end()
}, 30_000)

describe('#274 guest create-publish (ADR-135 §3)', () => {
  it('a space-EDIT-link guest creates a page PUBLISHED atomically, attributed to the anon id, and can edit it', async () => {
    const anonId = anon()
    const tok = await mkSpaceTok(await mkSpaceLink('edit'), 'edit', anonId)
    const r = await createAsGuest(tok, { title: 'wiki page' })
    expect(r.statusCode, r.body).toBe(201)
    const page = r.json() as { id: string; title: string; published: boolean }
    createdPages.push(page.id)
    expect(page.title).toBe('wiki page')
    expect(page.published).toBe(true) // the RESPONSE reflects the published birth too (not just the row)

    // Published from birth: row state + the FGA release tuples are all present.
    const [row] = await admin`SELECT published_at, published_md, published_revision_id, created_by FROM pages WHERE id = ${page.id}`
    expect(row.published_at).not.toBeNull()
    expect(row.published_md).toBe('')
    expect(row.published_revision_id).not.toBeNull()
    expect(row.created_by).toBe(anonId) // anon attribution, never a member sub
    const [rev] = await admin`SELECT created_by FROM revisions WHERE id = ${row.published_revision_id}`
    expect(rev.created_by).toBe(anonId)
    const { tuples } = await fgaClient.read({ object: `page:${page.id}` })
    const has = (relation: string, user: string) => (tuples ?? []).some((t) => t.key?.relation === relation && t.key?.user === user)
    expect(has('space', `space:${spaceId}`)).toBe(true)
    expect(has('published', 'user:*')).toBe(true)
    expect(has('published', 'share_link:*')).toBe(true)
    expect(has('manage_direct', anonId)).toBe(false) // a guest owns nothing — no manage path

    // The creating link EDITS the new page via edit_from_space; a fresh publish round-trips (200).
    const pub = await app.inject({ method: 'POST', url: `/pages/${page.id}/publish`, headers: { host: 'dev.localhost', authorization: `Bearer ${tok}` } })
    expect(pub.statusCode, pub.body).toBe(200)
    // And the page is in the guest tree (published → listPages includes it for the link principal).
    const list = await app.inject({ method: 'GET', url: `/spaces/${spaceId}/pages`, headers: guestHeaders(tok) })
    expect((list.json() as { id: string }[]).map((p) => p.id)).toContain(page.id)
  })

  it('a VIEW space link cannot create (401 at the hook), and a PAGE edit link cannot create in the space (403 at FGA)', async () => {
    const viewTok = await mkSpaceTok(await mkSpaceLink('view'), 'view', anon())
    // The auth hook's convenience guard rejects a view token on an edit route before the handler;
    // FGA (space#editor) is the real gate for admitted tokens (the page-link case below).
    expect((await createAsGuest(viewTok)).statusCode).toBe(401)

    const pl = await app.inject({ method: 'POST', url: '/share-links', headers: dev, payload: { resource: { type: 'page', id: seedPageId }, capability: 'edit', expiresInSeconds: null } })
    expect(pl.statusCode).toBe(201)
    const pageTok = await mintGuestToken(guestCfg, { tenantId: TENANT, shareLinkId: (pl.json() as { id: string }).id, resource: { type: 'page', id: seedPageId }, capability: 'edit', anonId: anon() })
    expect((await createAsGuest(pageTok)).statusCode).toBe(403) // page edit ≠ space editor
  })

  it('member-only seeds are ignored on the guest branch: templateId/fromPageId never leak content', async () => {
    const tok = await mkSpaceTok(await mkSpaceLink('edit'), 'edit', anon())
    const r = await createAsGuest(tok, { title: 'no-seed', fromPageId: seedPageId, templateId: '00000000-0000-0000-0000-000000000000' })
    expect(r.statusCode, r.body).toBe(201) // NOT a 404 on the bogus template id — the field never reaches a resolver
    const page = r.json() as { id: string }
    createdPages.push(page.id)
    const [row] = await admin`SELECT published_md, ydoc FROM pages WHERE id = ${page.id}`
    expect(row.published_md).toBe('') // seed page's content did not copy
    expect(row.ydoc).toBeNull()
  })

  it('a guest CAN nest under a published page it can view (the positive parent path)', async () => {
    const tok = await mkSpaceTok(await mkSpaceLink('edit'), 'edit', anon())
    const r = await createAsGuest(tok, { title: 'child', parentId: seedPageId })
    expect(r.statusCode, r.body).toBe(201)
    const page = r.json() as { id: string; parentId: string | null }
    createdPages.push(page.id)
    expect(page.parentId).toBe(seedPageId)
  })

  it('a guest cannot nest under a page it cannot view (404) — a draft-parent probe is existence-hidden', async () => {
    const draftId = (await createPage(db, fgaClient, app.searchDriver, { tenantId: TENANT, spaceId, userId: 'dev-user', title: 'member draft' })).id
    createdPages.push(draftId)
    const tok = await mkSpaceTok(await mkSpaceLink('edit'), 'edit', anon())
    const r = await createAsGuest(tok, { parentId: draftId })
    expect(r.statusCode).toBe(404) // not 400 — the guest must not learn the draft exists
  })

  it('the created-page cap 429s with a STATIC reason code (link bucket); a co-editor session shares the link budget', async () => {
    await admin`UPDATE tenant_settings SET abuse_create_page_link_max = 1 WHERE tenant_id = ${TENANT}`
    const link = await mkSpaceLink('edit')
    const s1 = await mkSpaceTok(link, 'edit', anon())
    const s2 = await mkSpaceTok(link, 'edit', anon())
    const first = await createAsGuest(s1)
    expect(first.statusCode, first.body).toBe(201)
    createdPages.push((first.json() as { id: string }).id)
    const second = await createAsGuest(s2)
    expect(second.statusCode).toBe(429)
    expect(second.json()).toEqual({ error: 'rate limited', reason: 'create_rate' }) // static — no limit/id echo
  })

  it('members are untouched by the guest caps (create keeps working while the link cap is 1)', async () => {
    await admin`UPDATE tenant_settings SET abuse_create_page_link_max = 1, abuse_create_page_session_max = 1 WHERE tenant_id = ${TENANT}`
    for (let i = 0; i < 2; i++) {
      const r = await app.inject({ method: 'POST', url: `/spaces/${spaceId}/pages`, headers: dev, payload: { title: `member-${i}` } })
      expect(r.statusCode, r.body).toBe(201)
      createdPages.push((r.json() as { id: string }).id)
    }
  })
})

describe('#274 guest attachments (ADR-135 §4)', () => {
  async function guestPageAndToken(): Promise<{ pageId: string; tok: string }> {
    const tok = await mkSpaceTok(await mkSpaceLink('edit'), 'edit', anon())
    const r = await createAsGuest(tok, { title: 'attach target' })
    expect(r.statusCode, r.body).toBe(201)
    const pageId = (r.json() as { id: string }).id
    createdPages.push(pageId)
    return { pageId, tok }
  }
  const presign = (tok: string, pageId: string) =>
    app.inject({ method: 'POST', url: `/spaces/${spaceId}/pages/${pageId}/attachments/presign`, headers: guestHeaders(tok), payload: { filename: 'note.txt', contentType: 'text/plain' } })

  it('an edit-link guest uploads: presign → PUT → confirm (FGA edit on the page is the authority)', async () => {
    const { pageId, tok } = await guestPageAndToken()
    const pre = await presign(tok, pageId)
    expect(pre.statusCode, pre.body).toBe(201)
    const { attachmentId, uploadUrl } = pre.json() as { attachmentId: string; uploadUrl: string }
    expect((await fetch(uploadUrl, { method: 'PUT', body: 'guest bytes', headers: { 'Content-Type': 'text/plain' } })).ok).toBe(true)
    const conf = await app.inject({ method: 'POST', url: `/attachments/${attachmentId}/confirm`, headers: { host: 'dev.localhost', authorization: `Bearer ${tok}` } })
    expect(conf.statusCode, conf.body).toBe(200)
    expect((conf.json() as { sizeBytes: number }).sizeBytes).toBe(Buffer.byteLength('guest bytes'))
  })

  it('a VIEW-link guest cannot presign (401 — the hook rejects a view token on an edit route)', async () => {
    const viewTok = await mkSpaceTok(await mkSpaceLink('view'), 'view', anon())
    const r = await app.inject({ method: 'POST', url: `/spaces/${spaceId}/pages/${seedPageId}/attachments/presign`, headers: guestHeaders(viewTok), payload: { filename: 'x.txt', contentType: 'text/plain' } })
    expect(r.statusCode).toBe(401)
  })

  it('the guest attachment COUNT cap 429s at presign with a static reason', async () => {
    const { pageId, tok } = await guestPageAndToken()
    await admin`UPDATE tenant_settings SET abuse_attach_count_link_max = 1 WHERE tenant_id = ${TENANT}`
    expect((await presign(tok, pageId)).statusCode).toBe(201)
    const second = await presign(tok, pageId)
    expect(second.statusCode).toBe(429)
    expect(second.json()).toEqual({ error: 'rate limited', reason: 'attach_rate' })
  })

  it('the guest per-file SIZE cap 413s at confirm and drops the row (no storage residue); members are uncapped', async () => {
    const { pageId, tok } = await guestPageAndToken()
    await admin`UPDATE tenant_settings SET abuse_attach_guest_max_bytes = 4 WHERE tenant_id = ${TENANT}`
    const pre = await presign(tok, pageId)
    expect(pre.statusCode).toBe(201)
    const { attachmentId, uploadUrl } = pre.json() as { attachmentId: string; uploadUrl: string }
    expect((await fetch(uploadUrl, { method: 'PUT', body: 'way more than four bytes', headers: { 'Content-Type': 'text/plain' } })).ok).toBe(true)
    const conf = await app.inject({ method: 'POST', url: `/attachments/${attachmentId}/confirm`, headers: { host: 'dev.localhost', authorization: `Bearer ${tok}` } })
    expect(conf.statusCode).toBe(413)
    const rows = await admin`SELECT 1 FROM attachments WHERE id = ${attachmentId}`
    expect(rows.length).toBe(0) // rejected upload leaves no row

    // The same byte size confirms fine for a MEMBER (the cap is guest-only).
    const mp = await app.inject({ method: 'POST', url: `/spaces/${spaceId}/pages/${seedPageId}/attachments/presign`, headers: dev, payload: { filename: 'm.txt', contentType: 'text/plain' } })
    expect(mp.statusCode, mp.body).toBe(201)
    const m = mp.json() as { attachmentId: string; uploadUrl: string }
    expect((await fetch(m.uploadUrl, { method: 'PUT', body: 'way more than four bytes', headers: { 'Content-Type': 'text/plain' } })).ok).toBe(true)
    const mconf = await app.inject({ method: 'POST', url: `/attachments/${m.attachmentId}/confirm`, headers: { host: 'dev.localhost', authorization: 'Bearer dev-token' } })
    expect(mconf.statusCode, mconf.body).toBe(200)
    await admin`DELETE FROM attachments WHERE id = ${m.attachmentId}`.catch(() => {})
  })
})
