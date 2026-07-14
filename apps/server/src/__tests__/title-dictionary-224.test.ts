// Integration test — real Postgres + OpenFGA + Fastify, no mocks. #224 / ADR-104 authz core:
// the title dictionary IS the primary defence (viewer-scoped; Addendum 2 point 1), so its
// binding anti-tests live here:
//   1. viewer-scope leak: a member's dictionary omits a private title they cannot view, and the
//      looseness check — granting view makes it appear (the result depends on the FGA state).
//   2. guest dictionary is PUBLIC-only (binding): even the guest's OWN space-shared,
//      non-public page title is absent; a public published page's title is present. The
//      share_link principal is never given a reverse lookup (#244 typed-wildcard re-entry).
//   5. excerpt existence-hiding: deny and missing raise the SAME error shape (uniform 404 —
//      both serialize through the same HTTP error path, so no wording distinguishes them).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import * as Y from 'yjs'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { fgaClient, deleteObjectTuples } from '@wikistead/authz'
import { mintGuestToken } from '@wikistead/auth'
import { createSpace } from '../routes/spaces.js'
import { createPage, publishPage, setPagePublic, setPagePrivate, grantPageAccess, getTitleDictionary, getExcerpt } from '../routes/pages.js'
import { buildApp } from '../app.js'
import type { Tenant } from '@wikistead/types'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const TENANT = 'tenant_dev'
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'free', isolation: 'logical' }) as Tenant
const guestCfg = { secret: process.env.GUEST_TOKEN_SECRET!, ttlSeconds: 3600 }
const RUN = Date.now().toString(36)
const T_PUBLIC = `Dict Public Title ${RUN}`
const T_SHARED = `Dict Shared Title ${RUN}`
const T_PRIVATE = `Dict Private Title ${RUN}`
const ydoc = (text: string) => Buffer.from(Y.encodeStateAsUpdate((() => { const d = new Y.Doc(); d.getText('content').insert(0, text); return d })()))

let app: FastifyInstance
let db: TenantDb
let spaceId: string, pubId: string, sharedId: string, privId: string, linkId: string

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
  db = await acquireTenantDb(asTenant(TENANT))
  spaceId = (await createSpace(db, fgaClient, { tenantId: TENANT, userId: 'dev-user', plan: 'free', name: `dict-space-${RUN}` })).id
  const mk = async (title: string) => (await createPage(db, fgaClient, app.searchDriver, { tenantId: TENANT, spaceId, userId: 'dev-user', title })).id
  pubId = await mk(T_PUBLIC)
  sharedId = await mk(T_SHARED)
  privId = await mk(T_PRIVATE)
  // publish PUB + SHARED (a public page must be published; the guest binding also filters published-only)
  for (const id of [pubId, sharedId]) {
    await admin`UPDATE pages SET ydoc = ${ydoc(`# body of ${id}\n\nexcerpt text for ${id}`)} WHERE id = ${id}`
    await publishPage(db, fgaClient, app.searchDriver, app.storageDriver, { pageId: id, subject: 'user:dev-user', createdBy: 'user:dev-user' })
  }
  await setPagePublic(db, fgaClient, app.searchDriver, { pageId: pubId, tenantId: TENANT, userId: 'dev-user' })
  await setPagePrivate(db, fgaClient, app.searchDriver, { pageId: privId, tenantId: TENANT, userId: 'dev-user' })
  // a VIEW share link on the SHARED (non-public) page — the guest's own page, still not public
  const r = await app.inject({
    method: 'POST', url: '/share-links',
    headers: { host: 'dev.localhost', authorization: 'Bearer dev-token', 'content-type': 'application/json' },
    payload: { resource: { type: 'page', id: sharedId }, capability: 'view', expiresInSeconds: null },
  })
  linkId = (r.json() as { id: string }).id
}, 30_000)

afterAll(async () => {
  for (const id of [pubId, sharedId, privId]) {
    await app.searchDriver.deleteDoc(id).catch(() => {})
    await deleteObjectTuples(fgaClient, `page:${id}`).catch(() => {})
  }
  await admin`DELETE FROM share_links WHERE resource_id = ${sharedId}`.catch(() => {})
  await admin`DELETE FROM revisions WHERE page_id IN (${pubId}, ${sharedId})`.catch(() => {})
  await admin`DELETE FROM search_outbox WHERE page_id IN (${pubId}, ${sharedId}, ${privId})`.catch(() => {})
  await admin`DELETE FROM pages WHERE id IN (${pubId}, ${sharedId}, ${privId})`.catch(() => {})
  await admin`DELETE FROM spaces WHERE id = ${spaceId}`.catch(() => {})
  await deleteObjectTuples(fgaClient, `space:${spaceId}`).catch(() => {})
  await db.release()
  await app.close()
  await admin.end()
}, 30_000)

const titles = (r: { entries: { id: string; title: string }[] }) => r.entries.map((e) => e.title)

describe('#224 title dictionary — viewer scope (anti-tests 1/2/3a)', () => {
  it('the creator sees all three titles (their own view set)', async () => {
    const r = await getTitleDictionary(db, fgaClient, { subject: 'user:dev-user' })
    expect(titles(r)).toEqual(expect.arrayContaining([T_PUBLIC, T_SHARED, T_PRIVATE]))
    expect(r.capped).toBe(false)
  })

  it('anti-test 1: another member does NOT see the private title; granting view makes it appear (looseness)', async () => {
    const before = await getTitleDictionary(db, fgaClient, { subject: 'user:dict-other' })
    expect(titles(before)).not.toContain(T_PRIVATE)
    // looseness check: the omission must depend on the FGA state, not on a hardcoded filter.
    await grantPageAccess(db, fgaClient, app.searchDriver, { pageId: privId, tenantId: TENANT, userId: 'dev-user', grantee: 'user:dict-other', relation: 'view' })
    try {
      const after = await getTitleDictionary(db, fgaClient, { subject: 'user:dict-other' })
      expect(titles(after)).toContain(T_PRIVATE)
    } finally {
      // leave no residue for the guest assertions below
      await fgaClient.write({ deletes: [{ user: 'user:dict-other', relation: 'view_direct', object: `page:${privId}` }] }).catch(() => {})
    }
  })

  it('anti-test 2/3a (binding): a guest dictionary is PUBLIC-only — even their OWN shared non-public page is absent', async () => {
    const r = await getTitleDictionary(db, fgaClient, { subject: `share_link:${linkId}` })
    const t = titles(r)
    expect(t).toContain(T_PUBLIC) // public + published → present
    expect(t).not.toContain(T_SHARED) // the guest CAN view it, but it is not public → absent (binding)
    expect(t).not.toContain(T_PRIVATE)
  })

  it('guest token round-trips over HTTP on the dictionary route (binding anchored to their page)', async () => {
    const tok = await mintGuestToken(guestCfg, { tenantId: TENANT, shareLinkId: linkId, resource: { type: 'page', id: sharedId }, capability: 'view' })
    const res = await app.inject({ method: 'GET', url: `/pages/${sharedId}/title-dictionary`, headers: { host: 'dev.localhost', authorization: `Bearer ${tok}` } })
    expect(res.statusCode).toBe(200)
    const t = titles(res.json() as { entries: { id: string; title: string }[] })
    expect(t).toContain(T_PUBLIC)
    expect(t).not.toContain(T_SHARED)
  })
})

describe('#224 excerpt — display-time view re-confirmation (anti-test 5)', () => {
  it('a viewer gets title + a published excerpt', async () => {
    const r = await getExcerpt(db, fgaClient, { pageId: pubId, subject: 'user:dev-user' })
    expect(r.title).toBe(T_PUBLIC)
    expect(r.excerpt).toContain('excerpt text')
  })

  it('an unpublished page returns excerpt null (title only — already in the viewer dictionary)', async () => {
    const r = await getExcerpt(db, fgaClient, { pageId: privId, subject: 'user:dev-user' })
    expect(r.title).toBe(T_PRIVATE)
    expect(r.excerpt).toBeNull()
  })

  it('deny and missing raise the IDENTICAL error (uniform 404 — no existence oracle)', async () => {
    const errOf = async (pageId: string, subject: string) => {
      try { await getExcerpt(db, fgaClient, { pageId, subject }) } catch (e) {
        const err = e as Error & { statusCode?: number }
        return { statusCode: err.statusCode, message: err.message }
      }
      return null
    }
    const denied = await errOf(privId, 'user:dict-nobody') // exists, not viewable
    const missing = await errOf('00000000-0000-0000-0000-000000000000', 'user:dict-nobody') // absent
    expect(denied).not.toBeNull()
    expect(denied).toEqual(missing) // same statusCode AND same message → same serialized body
  })
})
