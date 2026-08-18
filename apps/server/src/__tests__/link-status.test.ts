// #276 / ADR-117: POST /pages/link-status — the dead-internal-link resolver. THE authz invariant under
// test is existence-hiding: the endpoint answers ONLY "can the viewer VIEW this id?", never "does it
// exist?". So a non-existent id, a page in a space the viewer isn't in, and a made-up UUID are ALL absent
// from `viewable` and INDISTINGUISHABLE from one another — no DB existence lookup, no oracle. Real Postgres
// + OpenFGA, driven through the real HTTP stack (buildApp + inject) so the route's guest/subject + dedupe/cap
// are exercised end-to-end.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import postgres from 'postgres'
import type { FastifyInstance } from 'fastify'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { fgaClient, deleteObjectTuples, writeTuples, deleteTuples } from '@wikistead/authz'
import { memberTuples, ensureMembers } from './helpers/membership.js'
import { mintGuestToken } from '@wikistead/auth'
import { LogicalSearchDriver } from '../search/index.js'
import { createSpace, deleteSpace } from '../routes/spaces.js'
import { createPage, MAX_LINK_STATUS_IDS } from '../routes/pages.js'
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

  // #751: this used to prove "bounded" with the clock and nothing else — 401 ids in, a 200 out, inside
  // the default five seconds. It had become a standing red, and the measurement says why: under the real
  // model a `view` on a page with NO tuples costs about 15 ms, because a "no" is only reached by
  // exhausting the union graph. 256 of them is roughly four seconds before anything else happens, so the
  // assertion was being decided by how loaded the machine was rather than by whether the cap holds.
  //
  // (Measured on the isolated stack: one 50-id batchCheck of ids nobody created = 730-820 ms against the
  // real model and 2 ms against an empty one; `filterAuthorized` over 256 = 4.8 s. The batching itself is
  // fine — 50 real checks in ONE round-trip — so there is nothing here to make faster.)
  //
  // So the bound is now COUNTED instead of timed: what reaches FGA is what the cap says, in batches the
  // store's limit allows. That is the claim anti-test 8 was making, said directly — and it is also
  // strictly more than the clock could ever say, because a slow machine and an unbounded fan-out looked
  // identical from the outside. The end-to-end call stays, with a budget taken from the number above.
  it('de-dupes and caps the batch (bounded work, anti-test 8)', async () => {
    const dup = await linkStatus([viewable, viewable, viewable])
    expect(dup.json().viewable).toEqual([viewable]) // duplicates collapse to one

    // Count what actually leaves for the store, per round-trip and in total.
    const real = app.fga.batchCheck.bind(app.fga)
    const waves: number[] = []
    const spy = vi.spyOn(app.fga, 'batchCheck').mockImplementation((async (body: { checks: unknown[] }, ...rest: unknown[]) => {
      waves.push(body.checks.length)
      return real(body as never, ...(rest as []))
    }) as never)
    try {
      // >cap ids are handled without error (capped/deduped, never unbounded); the viewable one still resolves
      const many = [viewable, ...Array.from({ length: 400 }, (_v, i) => `zz-${i}`)]
      const capped = await linkStatus(many)
      expect(capped.statusCode).toBe(200)
      expect(Array.isArray(capped.json().viewable)).toBe(true)
      expect(capped.json().viewable).toEqual([viewable]) // the one real page survives the cap
    } finally {
      spy.mockRestore()
    }
    const asked = waves.reduce((a, b) => a + b, 0)
    // The NUMBER, written out. Comparing against MAX_LINK_STATUS_IDS alone reads well and proves less
    // than it looks: measured, raising the constant to 400 left this green, because the expectation moved
    // with the thing it was checking. The cap is a ruling (#276 / ADR-117), so the ruling is what is
    // pinned here and the constant is checked against it.
    expect(MAX_LINK_STATUS_IDS, 'the cap is the ruled 256').toBe(256)
    // 401 ids in, 256 out. Not "fewer than 401" — the exact number, so a cap that silently grew is as
    // red as a cap that vanished.
    expect(asked, `ids sent to the store (waves: ${waves.join(', ')})`).toBe(256)
    // …in as few round-trips as the store's batch limit allows. `<= 50 per wave` alone would NOT say
    // this: a regression to one check per id is 256 waves of one, and every one of them is under fifty.
    // Counting the WAVES is what separates O(N/50) trips from O(N).
    expect(Math.max(...waves), 'no wave exceeds the store batch limit').toBeLessThanOrEqual(50)
    expect(waves.length, `round-trips for 256 ids (waves: ${waves.join(', ')})`).toBeLessThanOrEqual(Math.ceil(256 / 50))
  }, 30_000)

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
