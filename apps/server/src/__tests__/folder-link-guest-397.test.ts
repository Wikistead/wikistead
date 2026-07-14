// #397 (#218/): a FOLDER view share-link's guest must reach the folder's PUBLISHED
// DESCENDANTS over HTTP. The FGA model has cascaded folder grants since #218 (`view_direct from
// parent` + the `and published` draft gate), and collab already delegates to FGA — but the HTTP
// guest principal (principalForPage) still pre-bound a page token to EXACTLY its own pageId, so a
// descendant read 403'd BEFORE the FGA check (over-denial, not a leak). The fix removes the
// pre-binding: the token proves WHO (share_link:<id>), OpenFGA decides WHAT (the attachments-route
// pattern) — so a revoked link loses everything and an unrelated page stays a uniform 404.
// Real Postgres + OpenFGA + Fastify, guest tokens end to end (the private-sharelink-244 template).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { fgaClient, writeTuples, deleteTuples } from '@wikistead/authz'
import { mintGuestToken } from '@wikistead/auth'
import { buildApp } from '../app.js'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const TENANT = 'tenant_dev'
const SA = 'p397-space'
const FOLDER = 'p397-folder'   // published folder — the share-link's resource
const CHILD = 'p397-child'     // published child under FOLDER → the guest must read it (the bug)
const DRAFT = 'p397-draft'     // UNPUBLISHED child under FOLDER → stays 404 (the draft gate)
const OTHER = 'p397-other'     // published page in the same space, unrelated to the link → uniform 404
const LINK = 'p397-folder-link'
const guestCfg = { secret: process.env.GUEST_TOKEN_SECRET!, ttlSeconds: 300 }

let app: FastifyInstance
let folderAuth = ''

// The FOLDER link grant (what relationForResource writes for a page view link) + the #218 cascade
// skeleton: page#parent edges and the `published` marker PAIR on the published pages (publish writes
// them; a draft has none — that IS the visibility gate).
const publishedPair = (id: string) => [
  { user: 'user:*', relation: 'published', object: `page:${id}` },
  { user: 'share_link:*', relation: 'published', object: `page:${id}` },
]
const base = [
  { user: `share_link:${LINK}`, relation: 'view_direct', object: `page:${FOLDER}` },
  { user: `page:${FOLDER}`, relation: 'parent', object: `page:${CHILD}` },
  { user: `page:${FOLDER}`, relation: 'parent', object: `page:${DRAFT}` },
  { user: `space:${SA}`, relation: 'space', object: `page:${FOLDER}` },
  { user: `space:${SA}`, relation: 'space', object: `page:${CHILD}` },
  { user: `space:${SA}`, relation: 'space', object: `page:${OTHER}` },
  ...publishedPair(FOLDER),
  ...publishedPair(CHILD),
  ...publishedPair(OTHER),
]

const read = (id: string, auth: string) =>
  app.inject({ method: 'GET', url: `/pages/${id}/published`, headers: { host: 'dev.localhost', authorization: auth } })

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
  await admin`INSERT INTO spaces (id, tenant_id, name) VALUES (${SA}, ${TENANT}, 'p397') ON CONFLICT (id) DO NOTHING`
  await admin`INSERT INTO pages (id, tenant_id, space_id, title, published_md, published_at) VALUES (${FOLDER}, ${TENANT}, ${SA}, 'Folder', 'folder body', now()) ON CONFLICT (id) DO NOTHING`
  await admin`INSERT INTO pages (id, tenant_id, space_id, parent_id, title, published_md, published_at) VALUES (${CHILD}, ${TENANT}, ${SA}, ${FOLDER}, 'Child', 'child body', now()) ON CONFLICT (id) DO NOTHING`
  await admin`INSERT INTO pages (id, tenant_id, space_id, parent_id, title) VALUES (${DRAFT}, ${TENANT}, ${SA}, ${FOLDER}, 'Draft') ON CONFLICT (id) DO NOTHING`
  await admin`INSERT INTO pages (id, tenant_id, space_id, title, published_md, published_at) VALUES (${OTHER}, ${TENANT}, ${SA}, 'Other', 'other body', now()) ON CONFLICT (id) DO NOTHING`
  await writeTuples(fgaClient, base)
  folderAuth = `Bearer ${await mintGuestToken(guestCfg, { tenantId: TENANT, shareLinkId: LINK, resource: { type: 'page', id: FOLDER }, capability: 'view' })}`
})

afterAll(async () => {
  await app.close()
  await deleteTuples(fgaClient, base).catch(() => {})
  await admin`DELETE FROM pages WHERE id IN (${FOLDER}, ${CHILD}, ${DRAFT}, ${OTHER})`.catch(() => {})
  await admin`DELETE FROM spaces WHERE id = ${SA}`.catch(() => {})
  await admin.end()
  await pool.end()
})

describe('#397 folder-link guest HTTP read', () => {
  it('reads the folder itself (non-regression)', async () => {
    const res = await read(FOLDER, folderAuth)
    expect(res.statusCode).toBe(200)
  })

  it('reads a PUBLISHED child through the folder cascade (the bug: this 403d before FGA)', async () => {
    const res = await read(CHILD, folderAuth)
    expect(res.statusCode).toBe(200)
    expect(JSON.stringify(res.json())).toContain('child body')
  })

  it('an UNPUBLISHED child stays hidden (the draft gate — uniform 404, never the draft body)', async () => {
    const res = await read(DRAFT, folderAuth)
    expect(res.statusCode).toBe(404)
  })

  it('an unrelated page in the same space is a uniform 404 (no skeleton key, existence hidden)', async () => {
    const res = await read(OTHER, folderAuth)
    expect(res.statusCode).toBe(404)
  })

  it('revoking the one folder tuple cuts the whole subtree instantly', async () => {
    await deleteTuples(fgaClient, [{ user: `share_link:${LINK}`, relation: 'view_direct', object: `page:${FOLDER}` }])
    try {
      expect((await read(FOLDER, folderAuth)).statusCode).toBe(404)
      expect((await read(CHILD, folderAuth)).statusCode).toBe(404)
    } finally {
      await writeTuples(fgaClient, [{ user: `share_link:${LINK}`, relation: 'view_direct', object: `page:${FOLDER}` }])
    }
  })

  it('an EDIT folder link reaches a PUBLISHED descendant edit action; a draft stays out (the edit cascade)', async () => {
    // The symmetric newly-enabled behaviour: edit_direct cascades via edit_from_parent AND `and published`
    // (model.fga), so an EDIT folder link's guest can act on a published child but never a draft.
    const editAuth = `Bearer ${await mintGuestToken(guestCfg, { tenantId: TENANT, shareLinkId: 'p397-edit-link', resource: { type: 'page', id: FOLDER }, capability: 'edit' })}`
    const editTuple = [{ user: 'share_link:p397-edit-link', relation: 'edit_direct', object: `page:${FOLDER}` }]
    await writeTuples(fgaClient, editTuple)
    try {
      const pub = await app.inject({ method: 'POST', url: `/pages/${CHILD}/publish`, headers: { host: 'dev.localhost', authorization: editAuth } })
      expect(pub.statusCode).toBe(200) // published child: the cascade grants edit → publish succeeds
      const draft = await app.inject({ method: 'POST', url: `/pages/${DRAFT}/publish`, headers: { host: 'dev.localhost', authorization: editAuth } })
      expect(draft.statusCode).toBe(403) // draft child: edit_inherited requires `published` → denied (action = 403)
    } finally {
      await deleteTuples(fgaClient, editTuple).catch(() => {})
    }
  })

  it('a DIRECT child link and a SPACE link still work (non-regression of the other binding shapes)', async () => {
    const direct = `Bearer ${await mintGuestToken(guestCfg, { tenantId: TENANT, shareLinkId: 'p397-direct', resource: { type: 'page', id: CHILD }, capability: 'view' })}`
    const space = `Bearer ${await mintGuestToken(guestCfg, { tenantId: TENANT, shareLinkId: 'p397-space-link', resource: { type: 'space', id: SA }, capability: 'view' })}`
    const extra = [
      { user: 'share_link:p397-direct', relation: 'view_direct', object: `page:${CHILD}` },
      { user: 'share_link:p397-space-link', relation: 'viewer', object: `space:${SA}` },
    ]
    await writeTuples(fgaClient, extra)
    try {
      expect((await read(CHILD, direct)).statusCode).toBe(200)
      expect((await read(CHILD, space)).statusCode).toBe(200)
      expect((await read(OTHER, space)).statusCode).toBe(200) // a space link spans the space (unchanged)
    } finally {
      await deleteTuples(fgaClient, extra).catch(() => {})
    }
  })
})
