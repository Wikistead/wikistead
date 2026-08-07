// #623 / ADR-220 §6.2: the tree route answers `{ pages, truncated }` now — the state has nowhere to
// live in a bare array, and a quiet cut was the only thing the old contract could express.
// #244 / ADR-098 addendum: a space-share-link GUEST must NOT reach a PRIVATE page in the linked space.
//
// Root cause: the per-page PRIVATE marker was `user:*` ONLY, and OpenFGA's typed wildcard `user:*` matches
// only user-type principals — so `... but not private` never cut a `share_link:` guest, and the guest read
// private pages via `viewer from space`. The marker is now the PAIR [user:*, share_link:*] (model.fga),
// written/deleted together by setPagePrivate/unsetPagePrivate, and backfilled onto legacy pages
// (private:backfill). This locks the fix down at every surface the guest could reach.
//
// Real Postgres + OpenFGA + Fastify. The model-level checks are the authoritative gate (published read,
// space list, backlinks, revisions, search stage-2 all funnel through `view`); the HTTP cases prove the
// two headline leak surfaces from the repro (published body + space page list) and backlinks (#230, where
// the leak was discovered) are closed end to end.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { fgaClient, writeTuples, deleteTuples } from '@wikistead/authz'
import { mintGuestToken } from '@wikistead/auth'
import { buildApp } from '../app.js'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const TENANT = 'tenant_dev'
const SA = 'p244-space'
const PRIV = 'p244-private' // published, in SA, PRIVATE (pair-marked)
const PUB = 'p244-public'   // published, in SA, non-private — list contrast + backlink target
const SCR = 'p244-scratch'  // published, in SA — used to reproduce the leak then prove the fix
const MEMBER = 'p244-member' // a user ON the private page's allow list (direct view grant)
const LINK = 'p244-space-link'
const GUEST = `share_link:${LINK}`
const guestCfg = { secret: process.env.GUEST_TOKEN_SECRET!, ttlSeconds: 300 }

// PRIV references PUB in its published body → a backlink candidate for PUB that must be view-gated away.
const PRIV_BODY = `see [pub](/p/${PUB})`

let app: FastifyInstance
const H = { host: 'dev.localhost', authorization: '' as string }

// Space link → SA (view); SCR/PRIV/PUB all live in SA. Space comments are OPEN (audience = user:* +
// share_link:*) so the comment-deny case proves the guest is stopped by the CUT view_base, not by comments
// simply being off.
const base = [
  { user: GUEST, relation: 'viewer', object: `space:${SA}` },
  { user: `space:${SA}`, relation: 'space', object: `page:${PRIV}` },
  { user: `space:${SA}`, relation: 'space', object: `page:${PUB}` },
  { user: `space:${SA}`, relation: 'space', object: `page:${SCR}` },
  { user: 'user:*', relation: 'comment_open', object: `space:${SA}` },
  { user: 'share_link:*', relation: 'comment_open', object: `space:${SA}` },
  // Allow-list entry: a specific member keeps view via a DIRECT grant even though private cut inheritance.
  { user: `user:${MEMBER}`, relation: 'view_direct', object: `page:${PRIV}` },
]
// The PRIVATE marker as it must be written — the PAIR.
const privMarkers = [
  { user: 'user:*', relation: 'private', object: `page:${PRIV}` },
  { user: 'share_link:*', relation: 'private', object: `page:${PRIV}` },
]

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
  await admin`INSERT INTO spaces (id, tenant_id, name) VALUES (${SA}, ${TENANT}, 'p244') ON CONFLICT (id) DO NOTHING`
  await admin`INSERT INTO pages (id, tenant_id, space_id, title, published_md, published_at) VALUES (${PRIV}, ${TENANT}, ${SA}, 'Private', ${PRIV_BODY}, now()) ON CONFLICT (id) DO NOTHING`
  await admin`INSERT INTO pages (id, tenant_id, space_id, title, published_md, published_at) VALUES (${PUB}, ${TENANT}, ${SA}, 'Public', 'pub body', now()) ON CONFLICT (id) DO NOTHING`
  await admin`INSERT INTO pages (id, tenant_id, space_id, title, published_md, published_at) VALUES (${SCR}, ${TENANT}, ${SA}, 'Scratch', 'scr body', now()) ON CONFLICT (id) DO NOTHING`
  await writeTuples(fgaClient, [...base, ...privMarkers])
  const tok = await mintGuestToken(guestCfg, { tenantId: TENANT, shareLinkId: LINK, resource: { type: 'space', id: SA }, capability: 'view' })
  H.authorization = `Bearer ${tok}`
})

afterAll(async () => {
  await app.close()
  await deleteTuples(fgaClient, [...base, ...privMarkers]).catch(() => {})
  await deleteTuples(fgaClient, [
    { user: 'user:*', relation: 'private', object: `page:${SCR}` },
    { user: 'share_link:*', relation: 'private', object: `page:${SCR}` },
  ]).catch(() => {})
  await admin`DELETE FROM pages WHERE id IN (${PRIV}, ${PUB}, ${SCR})`.catch(() => {})
  await admin`DELETE FROM spaces WHERE id = ${SA}`.catch(() => {})
  await admin.end()
  await pool.end()
})

const check = (user: string, relation: string, page: string) =>
  fgaClient.check({ user, relation, object: `page:${page}` }).then((r) => r.allowed ?? false)

describe('#244 space-link guest ⊥ private page (FGA model)', () => {
  it('DENIES the guest view/edit/comment on the private page (the pair cuts every relation)', async () => {
    expect(await check(GUEST, 'view', PRIV)).toBe(false)
    expect(await check(GUEST, 'edit', PRIV)).toBe(false)
    // comment intersects view_base (`view_base and comment_open`); the cut view_base closes it even though
    // the space's comment audience is open — so an open-comments space is not a back door either.
    expect(await check(GUEST, 'comment', PRIV)).toBe(false)
  })

  it('still DENIES public (user:*) on the private page (no public-visibility regression)', async () => {
    expect(await check('user:*', 'view', PRIV)).toBe(false)
  })

  it('KEEPS the allow-listed member (direct grant) able to view (no over-deny)', async () => {
    expect(await check(`user:${MEMBER}`, 'view', PRIV)).toBe(true)
  })

  it('lets the guest comment on a NON-private page in the same space (sanity: comments really are open)', async () => {
    expect(await check(GUEST, 'comment', PUB)).toBe(true)
  })

  it('REPRODUCES the leak with user:* only, then FIXES it with the share_link:* pair (silent-revert guard)', async () => {
    // Legacy/pre-backfill state — only the user:* marker. The typed wildcard misses the guest → leak.
    await writeTuples(fgaClient, [{ user: 'user:*', relation: 'private', object: `page:${SCR}` }])
    expect(await check(GUEST, 'view', SCR)).toBe(true) // ← the bug: private page readable by the guest
    // Add the share_link:* half of the pair (what the model change + backfill enforce) → closed.
    await writeTuples(fgaClient, [{ user: 'share_link:*', relation: 'private', object: `page:${SCR}` }])
    expect(await check(GUEST, 'view', SCR)).toBe(false)
    // unsetPagePrivate deletes BOTH markers → inheritance resumes (the guest, a space viewer, sees it again).
    await deleteTuples(fgaClient, [
      { user: 'user:*', relation: 'private', object: `page:${SCR}` },
      { user: 'share_link:*', relation: 'private', object: `page:${SCR}` },
    ])
    expect(await check(GUEST, 'view', SCR)).toBe(true)
  })
})

describe('#244 space-link guest ⊥ private page (HTTP end to end)', () => {
  it('cannot read the private page published body', async () => {
    const res = await app.inject({ method: 'GET', url: `/pages/${PRIV}/published`, headers: H })
    expect(res.statusCode).not.toBe(200)
    expect([403, 404]).toContain(res.statusCode)
    expect(JSON.stringify(res.json())).not.toContain('see [pub]')
  })

  it('does not see the private page in the space page list (but sees the public one)', async () => {
    const res = await app.inject({ method: 'GET', url: `/spaces/${SA}/pages`, headers: H })
    expect(res.statusCode).toBe(200)
    const ids = (res.json() as { pages: { id: string }[] }).pages.map((p) => p.id)
    expect(ids).toContain(PUB)
    expect(ids).not.toContain(PRIV)
  })

  it('does not leak the private page as a backlink of the public page (#230 discovery path)', async () => {
    const res = await app.inject({ method: 'GET', url: `/pages/${PUB}/backlinks`, headers: H })
    expect(res.statusCode).toBe(200)
    // ⚠️ /backlinks still answers a bare array — only the TREE route changed shape. A blanket
    // search-and-replace rewrote this line too and it failed with "cannot read 'map' of undefined".
    const ids = (res.json() as { id: string }[]).map((p) => p.id)
    expect(ids).not.toContain(PRIV)
  })
})
