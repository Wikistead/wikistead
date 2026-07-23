// #449 / ADR-173: guest search over a space share link. The permission-leak class — every anti-test
// drives the REAL two-stage path (Meili candidates → FGA stage-2 on the share_link principal) over
// HTTP with a real space link, and asserts that what a guest must never see appears in NEITHER the
// result list NOR the has-more signal. Real Postgres + OpenFGA + Meili + Fastify, no mocks.
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { fgaClient, deleteObjectTuples, writeTuples, deleteTuples } from '@wikistead/authz'
import { mintGuestToken } from '@wikistead/auth'
import { createSpace } from '../routes/spaces.js'
import { createPage, publishPage } from '../routes/pages.js'
import { setPagePublic, setPagePrivate } from '../routes/pages.js'
import { revokeShareLink } from '../routes/share-links.js'
import { buildApp } from '../app.js'
import type { Tenant } from '@wikistead/types'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const TENANT = 'tenant_dev'
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'free', isolation: 'logical' }) as Tenant
const guestCfg = { secret: process.env.GUEST_TOKEN_SECRET!, ttlSeconds: 3600 }
const dev = { host: 'dev.localhost', authorization: 'Bearer dev-token', 'content-type': 'application/json' }
const TAG = `gs449${Date.now().toString(36)}` // a query token unique to this run, so hits are ours

let app: FastifyInstance
let db: TenantDb
let spaceId: string
let otherSpaceId: string
const pages: string[] = []

let seq = 0
const anon = () => `anon:${(Date.now() + seq++).toString(16).slice(-12).padStart(12, '0')}`
const gHeaders = (token: string) => ({ host: 'dev.localhost', authorization: `Bearer ${token}` })

async function mkSpaceLink(space: string, capability: 'view' | 'edit', expiresInSeconds: number | null = null): Promise<string> {
  const r = await app.inject({ method: 'POST', url: '/share-links', headers: dev, payload: { resource: { type: 'space', id: space }, capability, expiresInSeconds } })
  expect(r.statusCode, r.body).toBe(201)
  return (r.json() as { id: string }).id
}
const mkSpaceTok = (linkId: string, space: string, capability: 'view' | 'edit', anonId: string, ttl = 3600) =>
  mintGuestToken({ ...guestCfg, ttlSeconds: ttl }, { tenantId: TENANT, shareLinkId: linkId, resource: { type: 'space', id: space }, capability, anonId })

// A member page: created (indexed by title), optionally published (gets the page#space edge a guest's
// view_base_from_space needs) and optionally made public/private.
async function makePage(space: string, title: string, opts: { publish?: boolean; makePublic?: boolean; makePrivate?: boolean } = {}): Promise<string> {
  const p = await createPage(db, fgaClient, app.searchDriver, { tenantId: TENANT, spaceId: space, userId: 'dev-user', title })
  pages.push(p.id)
  if (opts.publish) await publishPage(db, fgaClient, app.searchDriver, app.storageDriver, { pageId: p.id, subject: 'user:dev-user', createdBy: 'user:dev-user' })
  if (opts.makePublic) await setPagePublic(db, fgaClient, app.searchDriver, { pageId: p.id, tenantId: TENANT, userId: 'dev-user' })
  if (opts.makePrivate) await setPagePrivate(db, fgaClient, app.searchDriver, { pageId: p.id, tenantId: TENANT, userId: 'dev-user' })
  return p.id
}

const search = (token: string, q: string, extra = '') =>
  app.inject({ method: 'GET', url: `/search?q=${encodeURIComponent(q)}${extra}`, headers: gHeaders(token) })
const titlesOf = (body: string) => (JSON.parse(body) as { title: string }[]).map((h) => h.title)

let visibleId: string, privateId: string, draftId: string, otherId: string

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
  await admin`INSERT INTO tenant_settings (tenant_id) VALUES (${TENANT}) ON CONFLICT (tenant_id) DO NOTHING`
  db = await acquireTenantDb(asTenant(TENANT))
  spaceId = (await createSpace(db, fgaClient, { tenantId: TENANT, userId: 'dev-user', plan: 'free', name: `${TAG}-s` })).id
  otherSpaceId = (await createSpace(db, fgaClient, { tenantId: TENANT, userId: 'dev-user', plan: 'free', name: `${TAG}-o` })).id

  // In the shared space: a published page the guest may see; a published-then-private page they must
  // not; a DRAFT whose title matches (indexed by title, no page#space edge → fortress-only deny).
  visibleId = await makePage(spaceId, `${TAG} visible one`, { publish: true })
  privateId = await makePage(spaceId, `${TAG} private one`, { publish: true, makePrivate: true })
  draftId = await makePage(spaceId, `${TAG} draft one`) // never published
  // In ANOTHER space: a published page, to prove the space scope holds even when the guest asks for it.
  otherId = await makePage(otherSpaceId, `${TAG} other one`, { publish: true })
  await new Promise((r) => setTimeout(r, 1800)) // let the Meili upserts settle
}, 60_000)

afterEach(async () => {
  await admin`UPDATE tenant_settings SET abuse_search_rate_link_max = NULL, abuse_search_rate_session_max = NULL WHERE tenant_id = ${TENANT}`
})

afterAll(async () => {
  for (const id of pages) { await app.searchDriver.deleteDoc(id).catch(() => {}); await deleteObjectTuples(fgaClient, `page:${id}`).catch(() => {}) }
  await admin`DELETE FROM pages WHERE space_id IN (${spaceId}, ${otherSpaceId})`.catch(() => {})
  await admin`DELETE FROM spaces WHERE id IN (${spaceId}, ${otherSpaceId})`.catch(() => {})
  await deleteObjectTuples(fgaClient, `space:${spaceId}`).catch(() => {})
  await deleteObjectTuples(fgaClient, `space:${otherSpaceId}`).catch(() => {})
  await db.release()
  await app.close()
  await admin.end()
  await pool.end()
})

describe('#449 / ADR-173: guest search leak class', () => {
  it('returns a space-published page to a view-link guest — and ONLY the allowed one', async () => {
    const tok = await mkSpaceTok(await mkSpaceLink(spaceId, 'view'), spaceId, 'view', anon())
    const res = await search(tok, TAG)
    expect(res.statusCode, res.body).toBe(200)
    const titles = titlesOf(res.body)
    expect(titles).toContain(`${TAG} visible one`)
    expect(titles, 'a private page is never returned').not.toContain(`${TAG} private one`)
    expect(titles, 'a DRAFT title is never returned (fortress-only: no page#space edge)').not.toContain(`${TAG} draft one`)
    expect(titles, 'another space is never returned').not.toContain(`${TAG} other one`)
  })

  it('ignores a client-supplied spaceId pointing at ANOTHER space', async () => {
    const tok = await mkSpaceTok(await mkSpaceLink(spaceId, 'view'), spaceId, 'view', anon())
    // ask for the other space explicitly — the server must overwrite it with the link's own space
    const res = await search(tok, TAG, `&spaceId=${encodeURIComponent(otherSpaceId)}`)
    expect(res.statusCode).toBe(200)
    const titles = titlesOf(res.body)
    expect(titles, "the other space's page never leaks via a supplied spaceId").not.toContain(`${TAG} other one`)
    expect(titles, 'and the guest still sees their own space').toContain(`${TAG} visible one`)
  })

  it('gives a PAGE-scoped link guest a uniform empty result (no space to search)', async () => {
    const linkId = (await app.inject({ method: 'POST', url: '/share-links', headers: dev, payload: { resource: { type: 'page', id: visibleId }, capability: 'view', expiresInSeconds: null } })).json() as { id: string }
    const tok = await mintGuestToken(guestCfg, { tenantId: TENANT, shareLinkId: linkId.id, resource: { type: 'page', id: visibleId }, capability: 'view', anonId: anon() })
    const res = await search(tok, TAG)
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body), 'a page link has no candidate set — uniform []').toEqual([])
  })

  it('an EDIT link implies view (search works) and its results are the same allowed set', async () => {
    const tok = await mkSpaceTok(await mkSpaceLink(spaceId, 'edit'), spaceId, 'edit', anon())
    const res = await search(tok, TAG)
    expect(res.statusCode).toBe(200)
    const titles = titlesOf(res.body)
    expect(titles).toContain(`${TAG} visible one`)
    expect(titles).not.toContain(`${TAG} private one`)
  })

  it('a time-bounded link searches before expiry and is refused after', async () => {
    const linkId = await mkSpaceLink(spaceId, 'view', 3600)
    const live = await mkSpaceTok(linkId, spaceId, 'view', anon())
    expect((await search(live, TAG)).statusCode, 'the current_time context lets a live timed link through').toBe(200)
    expect(titlesOf((await search(live, TAG)).body)).toContain(`${TAG} visible one`)

    // an already-expired token on the same link: the auth hook rejects it before the handler
    const expired = await mintGuestToken({ ...guestCfg, ttlSeconds: -10 }, { tenantId: TENANT, shareLinkId: linkId, resource: { type: 'space', id: spaceId }, capability: 'view', anonId: anon() })
    expect((await search(expired, TAG)).statusCode, 'an expired token never reaches search').toBe(401)
  })

  it('never returns a TRASHED page in the shared space', async () => {
    const tok = await mkSpaceTok(await mkSpaceLink(spaceId, 'view'), spaceId, 'view', anon())
    // the trash marker is a [user:*, share_link:*] pair (#244): the guest is a share_link principal
    const trash = [
      { user: 'user:*', relation: 'trashed', object: `page:${visibleId}` },
      { user: 'share_link:*', relation: 'trashed', object: `page:${visibleId}` },
    ]
    await writeTuples(fgaClient, trash)
    try {
      expect(titlesOf((await search(tok, TAG)).body), 'a trashed page drops out of guest results').not.toContain(`${TAG} visible one`)
    } finally { await deleteTuples(fgaClient, trash).catch(() => {}) }
  })

  it('never returns a page the link is RESTRICTED from (member-restrict marker on the share_link)', async () => {
    const linkId = await mkSpaceLink(spaceId, 'view')
    const tok = await mkSpaceTok(linkId, spaceId, 'view', anon())
    // restricted subtracts from view_live (model.fga: view_live = viewable but not restricted); the
    // restrict marker enumerates share_link, so a link restricted from this page cannot view it
    const restr = { user: `share_link:${linkId}`, relation: 'restricted', object: `page:${visibleId}` }
    await writeTuples(fgaClient, [restr])
    try {
      expect(titlesOf((await search(tok, TAG)).body), 'a restricted page is cut at stage 2').not.toContain(`${TAG} visible one`)
    } finally { await deleteTuples(fgaClient, [restr]).catch(() => {}) }
  })

  it('a REVOKED link returns nothing, even with a still-live token', async () => {
    const linkId = await mkSpaceLink(spaceId, 'view')
    const tok = await mkSpaceTok(linkId, spaceId, 'view', anon())
    expect(titlesOf((await search(tok, TAG)).body), 'it works before revocation').toContain(`${TAG} visible one`)
    // revocation is one tuple delete (the #106 invariant) — the token is still validly signed, but
    // the share_link no longer views the space, so stage 2 refuses every hit
    await revokeShareLink(db, fgaClient, { id: linkId, userId: 'dev-user', tenantId: TENANT })
    const after = await search(tok, TAG)
    expect(after.statusCode).toBe(200)
    expect(JSON.parse(after.body), 'a revoked link sees nothing (no cached leak)').toEqual([])
  })

  it('has-more reflects only the AUTHORIZED count, never the candidate density', async () => {
    const tok = await mkSpaceTok(await mkSpaceLink(spaceId, 'view'), spaceId, 'view', anon())
    const res = await search(tok, TAG)
    expect(res.statusCode).toBe(200)
    // the candidate window includes the private and draft docs the guest cannot see, but only one
    // page is authorized (< page size), so has-more is false — the density of hidden pages never leaks
    expect(res.headers['x-search-has-more'], 'has-more is false when the authorized count is below a page').toBe('false')
    expect(titlesOf(res.body).length).toBe(1)
  })

  it('rate-caps a guest with a static reason once the per-link budget is spent', async () => {
    await admin`UPDATE tenant_settings SET abuse_search_rate_link_max = 2 WHERE tenant_id = ${TENANT}`
    const tok = await mkSpaceTok(await mkSpaceLink(spaceId, 'view'), spaceId, 'view', anon())
    expect((await search(tok, TAG)).statusCode).toBe(200)
    expect((await search(tok, TAG)).statusCode).toBe(200)
    const capped = await search(tok, TAG)
    expect(capped.statusCode, 'the third query trips the per-link cap').toBe(429)
    expect((JSON.parse(capped.body) as { reason: string }).reason, 'a static reason — nothing about the query').toBe('search_rate')
  })
})

// #449 addendum (thereview ruling): the guest search-PREVIEW pane fetches
// `GET /pages/:id/published` with the GUEST token — the same guest-authorized route the reading
// surface uses. These pin the fortress the preview relies on: a viewable published page previews
// (title + body, view AND edit links), while a draft / another space's page / a private page 404s
// uniformly (existence-hiding on the preview path — the pane goes empty, never an oracle).
describe('#449 addendum: the guest preview fetch (/published with a guest token)', () => {
  const previewFetch = (token: string, pageId: string) =>
    app.inject({ method: 'GET', url: `/pages/${pageId}/published`, headers: gHeaders(token) })

  it('returns title + published body for a space-published page, on view AND edit links', async () => {
    for (const cap of ['view', 'edit'] as const) {
      const tok = await mkSpaceTok(await mkSpaceLink(spaceId, cap), spaceId, cap, anon())
      const res = await previewFetch(tok, visibleId)
      expect(res.statusCode, `${cap} link: ${res.body}`).toBe(200)
      const body = res.json() as { title: string; publishedMd: string | null }
      expect(body.title).toBe(`${TAG} visible one`)
      expect(body.publishedMd, 'the published body rides along for the pane').not.toBeNull()
    }
  })

  it('404s for a DRAFT page id (existence-hiding on the preview path)', async () => {
    const tok = await mkSpaceTok(await mkSpaceLink(spaceId, 'view'), spaceId, 'view', anon())
    expect((await previewFetch(tok, draftId)).statusCode, 'a draft previews as 404, same as missing').toBe(404)
  })

  it("404s for another space's page and for a private page (uniform deny)", async () => {
    const tok = await mkSpaceTok(await mkSpaceLink(spaceId, 'view'), spaceId, 'view', anon())
    expect((await previewFetch(tok, otherId)).statusCode, "another space's page hides").toBe(404)
    expect((await previewFetch(tok, privateId)).statusCode, 'a private page hides').toBe(404)
  })
})
