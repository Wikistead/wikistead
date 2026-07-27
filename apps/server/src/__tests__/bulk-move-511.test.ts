// #511 / ADR-185 (slice 5): bulk MOVE. Same non-negotiables as the other verbs — per-page authz re-run,
// partial success, no existence oracle, a 500-page cap, member-only — plus the one thing that is specific
// to this verb: the approved decision requires `manage` on BOTH sides.
//
// That last part is why this cannot be pure delegation. movePage's own cross-space gate asks for `manage`
// on the page and only `edit` on the destination space, so a bulk call that just delegated would ship a
// weaker destination gate than the one that was approved. The first test here is aimed straight at that.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { fgaClient, writeTuples, deleteTuples } from '@wikistead/authz'
import { createSpace, deleteSpace } from '../routes/spaces.js'
import { createPage, deletePage, bulkMovePages, BULK_MOVE_CAP } from '../routes/pages.js'
import { buildApp } from '../app.js'
import type { Tenant } from '@wikistead/types'

const adminPool = postgres(process.env.DATABASE_ADMIN_URL!)
const TENANT = 'tenant_dev'
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'free', isolation: 'logical' }) as Tenant
// The caller must NOT be a tenant admin: `space#manager` unions `admin from tenant`, so an admin manages
// every space and the both-sides gate could never be observed failing. This bit me — the first cut used
// dev-user and the destination test passed the gate it was meant to prove.
const CALLER = 'bulk-move-caller'  // plain member with space_creator ⇒ manages only what they create
const OTHER = 'dev-user'           // owns a third space the caller can see but not manage

let app: FastifyInstance
let tenant: Tenant
let db: TenantDb
let source = ''
let dest = ''
let foreign = ''                   // a space CALLER can view but not manage
const ids: string[] = []

async function mkPage(title: string, spaceId = source, userId = CALLER): Promise<string> {
  const p = await createPage(db, fgaClient, app.searchDriver, { tenantId: tenant.id, spaceId, userId, title })
  ids.push(p.id)
  return p.id
}
const spaceOf = async (id: string) =>
  (await db.sql<{ space_id: string }[]>`SELECT space_id FROM pages WHERE id = ${id}`)[0]?.space_id ?? null

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
  tenant = asTenant(TENANT)
  db = await acquireTenantDb(tenant)
  // #445 gates space creation on the tenant's `space_creator`; the caller needs it (and membership) to own
  // the two spaces this suite moves between.
  await writeTuples(fgaClient, [
    { user: `user:${CALLER}`, relation: 'member', object: `tenant:${tenant.id}` },
    { user: `user:${CALLER}`, relation: 'space_creator', object: `tenant:${tenant.id}` },
  ]).catch(() => {})
  source = (await createSpace(db, fgaClient, { tenantId: tenant.id, userId: CALLER, plan: tenant.plan, name: 'bulk-move-src' })).id
  dest = (await createSpace(db, fgaClient, { tenantId: tenant.id, userId: CALLER, plan: tenant.plan, name: 'bulk-move-dst' })).id
  // OTHER's space: CALLER is only a VIEWER there, so it is a destination they may see but not manage.
  foreign = (await createSpace(db, fgaClient, { tenantId: tenant.id, userId: OTHER, plan: tenant.plan, name: 'bulk-move-foreign' })).id
  await writeTuples(fgaClient, [{ user: `user:${CALLER}`, relation: 'viewer', object: `space:${foreign}` }])
}, 90_000)

afterAll(async () => {
  for (const id of ids) await deletePage(db, fgaClient, app.searchDriver, { pageId: id, userId: CALLER }).catch(() => {})
  await deleteTuples(fgaClient, [{ user: `user:${CALLER}`, relation: 'viewer', object: `space:${foreign}` }]).catch(() => {})
  await deleteTuples(fgaClient, [
    { user: `user:${CALLER}`, relation: 'space_creator', object: `tenant:${TENANT}` },
    { user: `user:${CALLER}`, relation: 'member', object: `tenant:${TENANT}` },
  ]).catch(() => {})
  for (const s of [source, dest]) await deleteSpace(db, fgaClient, app.searchDriver, { tenantId: tenant.id, spaceId: s, userId: CALLER }).catch(() => {})
  await deleteSpace(db, fgaClient, app.searchDriver, { tenantId: tenant.id, spaceId: foreign, userId: OTHER }).catch(() => {})
  await adminPool`DELETE FROM members WHERE sub = ${CALLER}`.catch(() => {})
  await db.release(); await app.close(); await adminPool.end(); await pool.end()
}, 90_000)

describe('#511 bulkMovePages — manage on BOTH sides, and no bulk bypass', () => {
  it('refuses a destination the caller can VIEW but not MANAGE, and moves nothing', async () => {
    const p = await mkPage('move-foreign')
    // Non-vacuity: the caller really can see that space, so the refusal below is about `manage`, not about
    // the space being invisible — otherwise this would pass for the wrong reason.
    const { allowed } = await fgaClient.check({ user: `user:${CALLER}`, relation: 'viewer', object: `space:${foreign}` })
    expect(allowed, 'the caller can view the destination').toBe(true)
    // …and is NOT a tenant admin, who would manage every space through `admin from tenant` and make the
    // refusal below unobservable.
    const admin = await fgaClient.check({ user: `user:${CALLER}`, relation: 'admin', object: `tenant:${TENANT}` })
    expect(admin.allowed, 'the caller is not a tenant admin').toBe(false)

    await expect(bulkMovePages(db, fgaClient, app.searchDriver, {
      spaceId: source, targetSpaceId: foreign, pageIds: [p], userId: CALLER,
    })).rejects.toMatchObject({ statusCode: 404 }) // 404, not 403: the status must not confirm the space exists
    expect(await spaceOf(p), 'the page did not move').toBe(source)
  })

  it('moves the selection into a space the caller manages, subtree and all', async () => {
    const parent = await mkPage('move-parent')
    const child = await createPage(db, fgaClient, app.searchDriver, { tenantId: tenant.id, spaceId: source, userId: CALLER, title: 'move-child', parentId: parent })
    ids.push(child.id)

    const res = await bulkMovePages(db, fgaClient, app.searchDriver, {
      spaceId: source, targetSpaceId: dest, pageIds: [parent], userId: CALLER,
    })
    expect(res).toMatchObject({ moved: 1, skipped: 0 })
    expect(await spaceOf(parent)).toBe(dest)
    // The descendant travels with its parent — a move that left children behind would orphan them in the
    // old space, which is the silent structural damage the ADR's cascade rule exists to prevent.
    expect(await spaceOf(child.id), 'the subtree came along').toBe(dest)
  })

  it('reports partial success, and an absent id reports what a forbidden one would', async () => {
    const ok = await mkPage('move-ok')
    const res = await bulkMovePages(db, fgaClient, app.searchDriver, {
      spaceId: source, targetSpaceId: dest, pageIds: [ok, '00000000-0000-0000-0000-000000000000'], userId: CALLER,
    })
    expect(res.moved).toBe(1)
    expect(res.results.find((r) => r.id !== ok), 'uniform reason').toMatchObject({ ok: false, reason: 'not_found' })
    expect(await spaceOf(ok)).toBe(dest)
  })

  it('a page in ANOTHER space is not moved through this space', async () => {
    const elsewhere = await mkPage('move-elsewhere', dest)
    const res = await bulkMovePages(db, fgaClient, app.searchDriver, {
      spaceId: source, targetSpaceId: dest, pageIds: [elsewhere], userId: CALLER,
    })
    expect(res.results[0]).toMatchObject({ ok: false, reason: 'not_found' })
  })

  it('a caller who cannot view the SOURCE space gets a uniform 404 for the whole request', async () => {
    await expect(bulkMovePages(db, fgaClient, app.searchDriver, {
      spaceId: source, targetSpaceId: dest, pageIds: [], userId: 'bulk-move-stranger',
    })).rejects.toMatchObject({ statusCode: 404 })
  })

  it('refuses the current space as the destination, and enforces the cap', async () => {
    await expect(bulkMovePages(db, fgaClient, app.searchDriver, {
      spaceId: source, targetSpaceId: source, pageIds: [], userId: CALLER,
    })).rejects.toMatchObject({ statusCode: 400, reason: 'same_space' })

    const tooMany = Array.from({ length: BULK_MOVE_CAP + 1 }, (_, i) => `id-${i}`)
    await expect(bulkMovePages(db, fgaClient, app.searchDriver, {
      spaceId: source, targetSpaceId: dest, pageIds: tooMany, userId: CALLER,
    })).rejects.toMatchObject({ statusCode: 400, reason: 'too_many' })
  })
})
