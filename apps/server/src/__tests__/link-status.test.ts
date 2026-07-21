// #276 / ADR-117: POST /pages/link-status — the dead-internal-link resolver. THE authz invariant under
// test is existence-hiding: the endpoint answers ONLY "can the viewer VIEW this id?", never "does it
// exist?". So a non-existent id, a page in a space the viewer isn't in, and a made-up UUID are ALL absent
// from `viewable` and INDISTINGUISHABLE from one another — no DB existence lookup, no oracle. Real Postgres
// + OpenFGA, driven through the real HTTP stack (buildApp + inject) so the route's guest/subject + dedupe/cap
// are exercised end-to-end.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import type { FastifyInstance } from 'fastify'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { fgaClient, deleteObjectTuples, writeTuples, deleteTuples } from '@wikistead/authz'
import { memberTuples, ensureMembers } from './helpers/membership.js'
import { mintGuestToken } from '@wikistead/auth'
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

let db: TenantDb
let app: FastifyInstance
let mySpace: string
let otherSpace: string
let viewable!: string // dev-user is a member (created it) → alive
let hidden!: string   // created by another user in a space dev-user is NOT in → dev-user can't view → dead
const NONEXISTENT = '00000000-0000-4000-8000-000000000000' // a well-formed but made-up id → dead
const cleanup: string[] = []

const linkStatus = (ids: unknown, token = 'dev-token') =>
  app.inject({
    method: 'POST',
    url: '/pages/link-status',
    headers: { host: HOST, authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    payload: { ids },
  })

beforeAll(async () => {
  await driver.ensureIndex()
  db = await acquireTenantDb(asTenant(TENANT))
  app = await buildApp(); await app.ready()
  // #471 / ADR-176: space creation is granted to this tenant's MEMBERS (it used to be a `user:*`
  // wildcard, which matched anyone the server authenticated at all), so a fixture acting as
  // someone must make them a member — which is what these subs always meant to be.
  await ensureMembers(TENANT, ['dev-user', 'ls-other-user'])
  const sfx = Date.now().toString(36)
  mySpace = (await createSpace(db, fgaClient, { tenantId: TENANT, userId: 'dev-user', plan: 'free', name: `ls-mine-${sfx}` })).id
  otherSpace = (await createSpace(db, fgaClient, { tenantId: TENANT, userId: 'ls-other-user', plan: 'free', name: `ls-other-${sfx}` })).id
  viewable = (await createPage(db, fgaClient, driver, { tenantId: TENANT, spaceId: mySpace, userId: 'dev-user', title: 'mine' })).id
  hidden = (await createPage(db, fgaClient, driver, { tenantId: TENANT, spaceId: otherSpace, userId: 'ls-other-user', title: 'theirs' })).id
  cleanup.push(viewable, hidden)
}, 60_000)

afterAll(async () => {
  for (const id of cleanup) {
    await deleteObjectTuples(fgaClient, `page:${id}`).catch(() => {})
    await admin`DELETE FROM search_outbox WHERE page_id = ${id}`.catch(() => {})
    await admin`DELETE FROM pages WHERE id = ${id}`.catch(() => {})
  }
  await deleteSpace(db, fgaClient, driver, { tenantId: TENANT, spaceId: mySpace, userId: 'dev-user' }).catch(() => {})
  await deleteSpace(db, fgaClient, driver, { tenantId: TENANT, spaceId: otherSpace, userId: 'ls-other-user' }).catch(() => {})
  await db.release(); await admin.end(); await pool.end()
}, 60_000)

describe('POST /pages/link-status (#276 / ADR-117)', () => {
  it('returns ONLY the viewable subset — a viewable page is alive', async () => {
    const res = await linkStatus([viewable])
    expect(res.statusCode).toBe(200)
    expect(res.json().viewable).toEqual([viewable])
  })

  it('a non-existent id AND a real-but-unviewable page are BOTH dead, and indistinguishable (no existence oracle)', async () => {
    const res = await linkStatus([viewable, hidden, NONEXISTENT])
    const view: string[] = res.json().viewable
    expect(view).toContain(viewable) // alive
    expect(view).not.toContain(hidden) // real private page → dead
    expect(view).not.toContain(NONEXISTENT) // made-up id → dead
    // the response carries NO signal that would tell the two dead ids apart (existence-hiding):
    expect(view).toEqual([viewable])
  })

  it('de-dupes and caps the batch (bounded work, anti-test 8)', async () => {
    const dup = await linkStatus([viewable, viewable, viewable])
    expect(dup.json().viewable).toEqual([viewable]) // duplicates collapse to one

    // >cap ids are handled without error (capped/deduped, never unbounded); the viewable one still resolves
    const many = [viewable, ...Array.from({ length: 400 }, (_v, i) => `zz-${i}`)]
    const capped = await linkStatus(many)
    expect(capped.statusCode).toBe(200)
    expect(Array.isArray(capped.json().viewable)).toBe(true)
  })

  it('ignores malformed ids (non-strings / empty) without erroring', async () => {
    const res = await linkStatus([viewable, '', 123, null, { x: 1 }])
    expect(res.statusCode).toBe(200)
    expect(res.json().viewable).toEqual([viewable])
  })

  it('rejects an unauthenticated caller (401)', async () => {
    const res = await app.inject({ method: 'POST', url: '/pages/link-status', headers: { host: HOST, 'content-type': 'application/json' }, payload: { ids: [viewable] } })
    expect(res.statusCode).toBe(401)
  })

  // ADR-117 anti-test 5: a GUEST (share-link) caller's dead-set is computed under its OWN capability — a
  // member-only page is dead to the guest, and the guest is bound to no pageId here (the batch), so the
  // per-id FGA `check` on `share_link:<id>` is the sole gate.
  it('a guest (share-link) sees ONLY the page its link grants — member-only pages are dead to it', async () => {
    const LINK = `ls-link-${Date.now().toString(36)}`
    // a page-view share link grants the guest `view_base` on its bound page (share-links.ts relationForResource)
    await writeTuples(fgaClient, [{ user: `share_link:${LINK}`, relation: 'view_direct', object: `page:${viewable}` }])
    try {
      const tok = await mintGuestToken(
        { secret: process.env.GUEST_TOKEN_SECRET!, ttlSeconds: 300 },
        { tenantId: TENANT, shareLinkId: LINK, resource: { type: 'page', id: viewable }, capability: 'view' },
      )
      const res = await linkStatus([viewable, hidden, NONEXISTENT], tok)
      expect(res.statusCode).toBe(200)
      // the guest may view its shared page — but the member-only page and the made-up id are BOTH dead to it
      expect(res.json().viewable).toEqual([viewable])
    } finally {
      await deleteTuples(fgaClient, [{ user: `share_link:${LINK}`, relation: 'view_direct', object: `page:${viewable}` }]).catch(() => {})
    }
  })
})
