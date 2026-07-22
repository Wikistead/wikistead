// #245 / ADR-112: the guest reader-chrome sidebar shows the linked space's page tree via GET
// /spaces/:id/pages. The chrome is convenience; the SERVER is the fortress. These anti-tests pin the
// capability boundary the sidebar relies on:
//   - a SPACE-scoped guest link lists only the pages it may view — a published in-space page appears, an
//     unpublished draft (no page#space) and a private page (post-#244 pair marker) do NOT;
//   - a PAGE-scoped guest link cannot reach the space tree at all (403), so it can never enumerate or
//     probe sibling pages.
// Real Postgres + OpenFGA + Fastify.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { fgaClient, writeTuples, deleteTuples } from '@wikistead/authz'
import { mintGuestToken } from '@wikistead/auth'
import { buildApp } from '../app.js'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const TENANT = 'tenant_dev'
const SPACE = 'gs245-space'
const PUB = 'gs245-published'    // published, in space, guest-viewable → in the tree
const DRAFT = 'gs245-draft'      // in space but never published (no page#space) → hidden
const PRIV = 'gs245-private'     // published but private (pair-marked) → hidden (post-#244)
const SPACE_LINK = 'gs245-space-link'
const EDIT_LINK = 'gs245-edit-link'      // #364 a SPACE EDIT link (space#editor, the share-links.ts:93 write shape)
const EDIT_LINK_TB = 'gs245-edit-link-tb'   // a TIME-BOUNDED edit link (non_expired), still in date → visible
const EDIT_LINK_EXP = 'gs245-edit-link-exp' // a time-bounded edit link past its expiry → hidden
const PAGE_LINK = 'gs245-page-link'
const guestCfg = { secret: process.env.GUEST_TOKEN_SECRET!, ttlSeconds: 300 }
// #364: the route stamps `context.current_time = now` on every guest check; these bracket it so the
// non_expired condition is exercised in BOTH directions (transported → future passes / past denies).
const FUTURE_EXPIRY = new Date(Date.now() + 60 * 60 * 1000).toISOString()
const PAST_EXPIRY = new Date(Date.now() - 60 * 60 * 1000).toISOString()

let app: FastifyInstance

const tuples = [
  { user: `share_link:${SPACE_LINK}`, relation: 'viewer', object: `space:${SPACE}` },
  // #364 the edit link writes `editor` ONLY (relationForResource, share-links.ts:93). Page view is
  // reached through the page-level `viewable`→`comment`→`edit_live` chain (edit ⊇ view), so the guest tree
  // must list the SAME published pages a view link does — an edit link that shows an empty sidebar is the bug.
  { user: `share_link:${EDIT_LINK}`, relation: 'editor', object: `space:${SPACE}` },
  // Time-bounded edit links (share-links.ts writes the non_expired twin when expiresInSeconds is set). The
  // route MUST transport current_time so the future link resolves and the expired one denies (design-review note).
  { user: `share_link:${EDIT_LINK_TB}`, relation: 'editor', object: `space:${SPACE}`, condition: { name: 'non_expired', context: { expires_at: FUTURE_EXPIRY } } },
  { user: `share_link:${EDIT_LINK_EXP}`, relation: 'editor', object: `space:${SPACE}`, condition: { name: 'non_expired', context: { expires_at: PAST_EXPIRY } } },
  { user: `space:${SPACE}`, relation: 'space', object: `page:${PUB}` },
  { user: `space:${SPACE}`, relation: 'space', object: `page:${PRIV}` },
  // DRAFT deliberately has NO page#space tuple (that's what "unpublished" means for the space inheritance).
  { user: 'user:*', relation: 'private', object: `page:${PRIV}` },
  { user: 'share_link:*', relation: 'private', object: `page:${PRIV}` },
]

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
  await admin`INSERT INTO spaces (id, tenant_id, name) VALUES (${SPACE}, ${TENANT}, 'gs245') ON CONFLICT (id) DO NOTHING`
  await admin`INSERT INTO pages (id, tenant_id, space_id, title, published_md, published_at) VALUES (${PUB}, ${TENANT}, ${SPACE}, 'Published', 'body', now()) ON CONFLICT (id) DO NOTHING`
  await admin`INSERT INTO pages (id, tenant_id, space_id, title, published_md, published_at) VALUES (${DRAFT}, ${TENANT}, ${SPACE}, 'Draft', NULL, NULL) ON CONFLICT (id) DO NOTHING`
  await admin`INSERT INTO pages (id, tenant_id, space_id, title, published_md, published_at) VALUES (${PRIV}, ${TENANT}, ${SPACE}, 'Private', 'secret', now()) ON CONFLICT (id) DO NOTHING`
  await writeTuples(fgaClient, tuples)
}, 60_000)

afterAll(async () => {
  await app.close()
  await deleteTuples(fgaClient, tuples).catch(() => {})
  await admin`DELETE FROM pages WHERE id IN (${PUB}, ${DRAFT}, ${PRIV})`.catch(() => {})
  await admin`DELETE FROM spaces WHERE id = ${SPACE}`.catch(() => {})
  await admin.end()
  await pool.end()
}, 60_000)

describe('#245 guest sidebar capability boundary', () => {
  it('a space-link guest tree lists the published page but NOT the draft or the private page', async () => {
    const tok = await mintGuestToken(guestCfg, { tenantId: TENANT, shareLinkId: SPACE_LINK, resource: { type: 'space', id: SPACE }, capability: 'view' })
    const res = await app.inject({ method: 'GET', url: `/spaces/${SPACE}/pages`, headers: { host: 'dev.localhost', authorization: `Bearer ${tok}` } })
    expect(res.statusCode).toBe(200)
    const ids = (res.json() as { id: string }[]).map((p) => p.id)
    expect(ids).toContain(PUB)
    expect(ids).not.toContain(DRAFT) // unpublished: no page#space → not view-inherited
    expect(ids).not.toContain(PRIV) // private: pair marker cuts the space-viewer inheritance for the guest
  })

  it('a space EDIT link lists the SAME tree as a view link (edit ⊇ view — no empty sidebar)', async () => {
    // #364 the reported symptom is "view link full, edit link empty sidebar". Reproduce the server
    // side directly: an edit-capability space token must return the identical published-page set.
    const tok = await mintGuestToken(guestCfg, { tenantId: TENANT, shareLinkId: EDIT_LINK, resource: { type: 'space', id: SPACE }, capability: 'edit' })
    const res = await app.inject({ method: 'GET', url: `/spaces/${SPACE}/pages`, headers: { host: 'dev.localhost', authorization: `Bearer ${tok}` } })
    expect(res.statusCode).toBe(200)
    const ids = (res.json() as { id: string }[]).map((p) => p.id)
    expect(ids).toContain(PUB)       // the edit link CAN view the published page → it must appear
    expect(ids).not.toContain(DRAFT) // still no draft leak
    expect(ids).not.toContain(PRIV)  // still no private leak
  })

  it('a time-bounded edit link still in date lists the tree (current_time transported through listPages)', async () => {
    // #364: a non_expired edit link resolves ONLY if the route's current_time reaches the batch view check.
    const tok = await mintGuestToken(guestCfg, { tenantId: TENANT, shareLinkId: EDIT_LINK_TB, resource: { type: 'space', id: SPACE }, capability: 'edit' })
    const res = await app.inject({ method: 'GET', url: `/spaces/${SPACE}/pages`, headers: { host: 'dev.localhost', authorization: `Bearer ${tok}` } })
    expect(res.statusCode).toBe(200)
    expect((res.json() as { id: string }[]).map((p) => p.id)).toContain(PUB)
  })

  it('an EXPIRED edit link lists nothing (the non_expired condition denies — keeps the future case honest)', async () => {
    // Makes the in-date case above non-vacuous: same shape, past expiry → the view chain collapses → empty tree.
    const tok = await mintGuestToken(guestCfg, { tenantId: TENANT, shareLinkId: EDIT_LINK_EXP, resource: { type: 'space', id: SPACE }, capability: 'edit' })
    const res = await app.inject({ method: 'GET', url: `/spaces/${SPACE}/pages`, headers: { host: 'dev.localhost', authorization: `Bearer ${tok}` } })
    expect(res.statusCode).toBe(200)
    expect((res.json() as { id: string }[]).map((p) => p.id)).not.toContain(PUB)
  })

  it('a PAGE-scoped guest link cannot reach the space tree at all (403 — no sibling probe)', async () => {
    // A page link bound to the published page must NOT be able to enumerate the space.
    const tok = await mintGuestToken(guestCfg, { tenantId: TENANT, shareLinkId: PAGE_LINK, resource: { type: 'page', id: PUB }, capability: 'view' })
    const res = await app.inject({ method: 'GET', url: `/spaces/${SPACE}/pages`, headers: { host: 'dev.localhost', authorization: `Bearer ${tok}` } })
    expect(res.statusCode).toBe(403)
  })
})

describe('#270 guest space header (GET /spaces/:id/info)', () => {
  it('a space-link guest gets ONLY the space name + icon (no accent/capability/members/id)', async () => {
    const tok = await mintGuestToken(guestCfg, { tenantId: TENANT, shareLinkId: SPACE_LINK, resource: { type: 'space', id: SPACE }, capability: 'view' })
    const res = await app.inject({ method: 'GET', url: `/spaces/${SPACE}/info`, headers: { host: 'dev.localhost', authorization: `Bearer ${tok}` } })
    expect(res.statusCode).toBe(200)
    const body = res.json() as Record<string, unknown>
    expect(body.name).toBe('gs245')
    expect(body.iconImageUrl).toBeNull() // no uploaded icon → null (client falls back to an initials chip)
    // #364 ①: homePageId joined the payload — VIEW-GATED (null here: this space has no viewable
    // home), so the minimal-field guarantee still holds: nothing else leaks.
    expect(body.homePageId).toBeNull()
    expect(Object.keys(body).sort()).toEqual(['homePageId', 'iconImageUrl', 'name']) // NO other field leaks
  })

  it('a PAGE-scoped guest link cannot read the space header (403 — resource-bound)', async () => {
    const tok = await mintGuestToken(guestCfg, { tenantId: TENANT, shareLinkId: PAGE_LINK, resource: { type: 'page', id: PUB }, capability: 'view' })
    const res = await app.inject({ method: 'GET', url: `/spaces/${SPACE}/info`, headers: { host: 'dev.localhost', authorization: `Bearer ${tok}` } })
    expect(res.statusCode).toBe(403)
  })
})
