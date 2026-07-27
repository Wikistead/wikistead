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
import { fgaClient, writeTuples, deleteTuples, check } from '@wikistead/authz'
import { createSpace, deleteSpace } from '../routes/spaces.js'
import { createPage, deletePage, publishPage, bulkMovePages, BULK_MOVE_CAP } from '../routes/pages.js'
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
  //`editor_member`, not `viewer`. With only viewer the caller lacks the destination's `edit` too,
  // so weakening the gate from `manage` to `edit` left the refusal test green — it could not tell the two
  // apart, which is the whole point of this suite. As an editor they hold `edit` and NOT `manage`, so the
  // refusal below is attributable to `manage` alone.
  await writeTuples(fgaClient, [{ user: `user:${CALLER}`, relation: 'editor_member', object: `space:${foreign}` }])
}, 90_000)

afterAll(async () => {
  for (const id of ids) await deletePage(db, fgaClient, app.searchDriver, { pageId: id, userId: CALLER }).catch(() => {})
  await deleteTuples(fgaClient, [{ user: `user:${CALLER}`, relation: 'editor_member', object: `space:${foreign}` }]).catch(() => {})
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
    // The caller can EDIT the destination but not MANAGE it: that is exactly the gap between what movePage
    // asks for and what the approved decision requires, so the refusal below is attributable to `manage`.
    expect(await check(fgaClient, `user:${CALLER}`, 'edit', { type: 'space', id: foreign }), 'edit: yes').toBe(true)
    expect(await check(fgaClient, `user:${CALLER}`, 'manage', { type: 'space', id: foreign }), 'manage: no').toBe(false)
    // …and is NOT a tenant admin, who would manage every space through `admin from tenant` and make the
    // refusal below unobservable.
    const admin = await fgaClient.check({ user: `user:${CALLER}`, relation: 'admin', object: `tenant:${TENANT}` })
    expect(admin.allowed, 'the caller is not a tenant admin').toBe(false)

    await expect(bulkMovePages(db, fgaClient, app.searchDriver, {
      spaceId: source, targetSpaceId: foreign, pageIds: [p], userId: CALLER,
    })).rejects.toMatchObject({ statusCode: 404 }) // 404, not 403: the status must not confirm the space exists
    expect(await spaceOf(p), 'the page did not move').toBe(source)
  })

  it('moves the selection into a space the caller manages, subtree and FGA link and all', async () => {
    const parent = await mkPage('move-parent')
    const child = await createPage(db, fgaClient, app.searchDriver, { tenantId: tenant.id, spaceId: source, userId: CALLER, title: 'move-child', parentId: parent })
    ids.push(child.id)
    // PUBLISH both: `page#space` is written at publish, so a draft has no link at all and the tuple swap is
    // skipped entirely.caught that this test's "the subtree came along" claim was DB-only — it never
    // exercised the FGA side it was meant to cover.
    for (const id of [parent, child.id]) {
      await publishPage(db, fgaClient, app.searchDriver, app.storageDriver, { pageId: id, subject: `user:${CALLER}`, createdBy: `user:${CALLER}` })
    }
    const linkedTo = async (pageId: string, spaceId: string) =>
      (await fgaClient.read({ user: `space:${spaceId}`, relation: 'space', object: `page:${pageId}` })).tuples?.length ?? 0
    expect(await linkedTo(parent, source), 'linked to the source before the move').toBeGreaterThan(0)

    const res = await bulkMovePages(db, fgaClient, app.searchDriver, {
      spaceId: source, targetSpaceId: dest, pageIds: [parent], userId: CALLER,
    })
    expect(res).toMatchObject({ moved: 1, skipped: 0 })
    expect(await spaceOf(parent)).toBe(dest)
    // The descendant travels with its parent — a move that left children behind would orphan them in the
    // old space, which is the silent structural damage the ADR's cascade rule exists to prevent.
    expect(await spaceOf(child.id), 'the subtree came along').toBe(dest)
    // …and the authority moved with it: the link the space inheritance actually traverses now points at the
    // destination, for the child as well as the root.
    expect(await linkedTo(parent, dest), 'the root is linked to the destination').toBeGreaterThan(0)
    expect(await linkedTo(parent, source), 'and no longer to the source').toBe(0)
    expect(await linkedTo(child.id, dest), 'the child is linked to the destination').toBeGreaterThan(0)
  })

  it('selecting a parent AND its child does not FLATTEN the hierarchy', async () => {
    // The Pages tab is a flat list with a select-all checkbox, so "select everything and move" is the
    // ordinary gesture. Each move lands at the destination root, so moving the child in its own right would
    // put it BESIDE its parent — silently destroying the structure the confirm promises to carry along.
    const parent = await mkPage('flat-parent')
    const child = await createPage(db, fgaClient, app.searchDriver, { tenantId: tenant.id, spaceId: source, userId: CALLER, title: 'flat-child', parentId: parent })
    ids.push(child.id)

    const res = await bulkMovePages(db, fgaClient, app.searchDriver, {
      spaceId: source, targetSpaceId: dest, pageIds: [parent, child.id], userId: CALLER,
    })
    expect(res.moved, 'one real move — the child rode along').toBe(1)
    expect(res.results.find((r) => r.id === child.id)).toMatchObject({ ok: true, movedWithAncestor: true })
    const [row] = await db.sql<{ parent_id: string | null }[]>`SELECT parent_id FROM pages WHERE id = ${child.id}`
    expect(row?.parent_id, 'the child is STILL under its parent').toBe(parent)
    expect(await spaceOf(child.id)).toBe(dest)
  })

  it('an ancestor SKIPS a level and still carries its descendant', async () => {
    // The first cut of the guard read the parent chain from the SELECTION only, so it stopped at the first
    // unselected parent: P > M > C with only P and C picked walked C -> M, found M unknown, and moved C to
    // the destination root anyway. The Pages tab does not show nesting, so nobody could see M in between.
    const p1 = await mkPage('gap-P')
    const mid = await createPage(db, fgaClient, app.searchDriver, { tenantId: tenant.id, spaceId: source, userId: CALLER, title: 'gap-M', parentId: p1 })
    const leaf = await createPage(db, fgaClient, app.searchDriver, { tenantId: tenant.id, spaceId: source, userId: CALLER, title: 'gap-C', parentId: mid.id })
    ids.push(mid.id, leaf.id)

    const res = await bulkMovePages(db, fgaClient, app.searchDriver, {
      spaceId: source, targetSpaceId: dest, pageIds: [p1, leaf.id], userId: CALLER,   // M deliberately NOT selected
    })
    expect(res.moved, 'only the ancestor is a move of its own').toBe(1)
    expect(res.results.find((r) => r.id === leaf.id)).toMatchObject({ ok: true, movedWithAncestor: true })
    const [row] = await db.sql<{ parent_id: string | null }[]>`SELECT parent_id FROM pages WHERE id = ${leaf.id}`
    expect(row?.parent_id, 'still under the unselected middle page').toBe(mid.id)
    expect(await spaceOf(leaf.id)).toBe(dest)
  })

  it('a descendant is NOT reported ok when its ancestor could not move', async () => {
    // The carried case used to assert ok on the assumption the ancestor moved. When the ancestor is skipped
    // the descendant never goes anywhere, and calling that a success is simply false.
    const p2 = await createPage(db, fgaClient, app.searchDriver, { tenantId: tenant.id, spaceId: source, userId: OTHER, title: 'stuck-P' })
    const kid = await createPage(db, fgaClient, app.searchDriver, { tenantId: tenant.id, spaceId: source, userId: OTHER, title: 'stuck-C', parentId: p2.id })
    ids.push(p2.id, kid.id)
    // OTHER owns them and they are drafts, so the caller's space inheritance never reaches them.
    expect(await check(fgaClient, `user:${CALLER}`, 'manage', { type: 'page', id: p2.id }), 'the caller cannot move the parent').toBe(false)

    const res = await bulkMovePages(db, fgaClient, app.searchDriver, {
      spaceId: source, targetSpaceId: dest, pageIds: [p2.id, kid.id], userId: CALLER,
    })
    expect(res.moved).toBe(0)
    expect(res.results.find((r) => r.id === kid.id), 'the descendant did not move, so it is not ok')
      .toMatchObject({ ok: false })
    expect(await spaceOf(kid.id), 'and the document agrees').toBe(source)
  })

  it('the space HOME cannot be moved out of its space', async () => {
    const home = await mkPage('the-home')
    await adminPool`UPDATE spaces SET home_page_id = ${home} WHERE id = ${source}`
    try {
      const res = await bulkMovePages(db, fgaClient, app.searchDriver, {
        spaceId: source, targetSpaceId: dest, pageIds: [home], userId: CALLER,
      })
      expect(res.results[0], 'refused with its own reason, not a permission one').toMatchObject({ ok: false, reason: 'space_home' })
      // Otherwise spaces.home_page_id keeps pointing at a page in ANOTHER space: the source has a home it
      // does not contain, and cannot create a new one while that row is alive.
      expect(await spaceOf(home), 'the home stayed put').toBe(source)
    } finally {
      await adminPool`UPDATE spaces SET home_page_id = NULL WHERE id = ${source}`
    }
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

  it("another tenant's space is not a destination, and says so the same way", async () => {
    // The FGA store is shared across tenants, so a space the caller manages ELSEWHERE passes the relation
    // check. Without the tenant-scoped lookup the move got as far as the composite foreign key and reported
    // `error`, breaking the uniform answer every other unreachable destination gives.
    const other = `tenant_bm_${Date.now().toString(36)}`
    await adminPool`INSERT INTO tenants (id, slug, plan) VALUES (${other}, ${other}, 'free')`
    await adminPool`INSERT INTO spaces (id, tenant_id, name) VALUES ('bm-cross-space', ${other}, 'Elsewhere')`
    await writeTuples(fgaClient, [{ user: `user:${CALLER}`, relation: 'manager', object: 'space:bm-cross-space' }]).catch(() => {})
    try {
      expect(await check(fgaClient, `user:${CALLER}`, 'manage', { type: 'space', id: 'bm-cross-space' }),
        'FGA alone would let this through').toBe(true)
      const p = await mkPage('move-cross-tenant')
      await expect(bulkMovePages(db, fgaClient, app.searchDriver, {
        spaceId: source, targetSpaceId: 'bm-cross-space', pageIds: [p], userId: CALLER,
      })).rejects.toMatchObject({ statusCode: 404 })
      expect(await spaceOf(p), 'nothing moved').toBe(source)
    } finally {
      await deleteTuples(fgaClient, [{ user: `user:${CALLER}`, relation: 'manager', object: 'space:bm-cross-space' }]).catch(() => {})
      await adminPool`DELETE FROM search_outbox WHERE tenant_id = ${other}`.catch(() => {})
      await adminPool`DELETE FROM audit_outbox WHERE tenant_id = ${other}`.catch(() => {})
      await adminPool`DELETE FROM audit_log WHERE tenant_id = ${other}`.catch(() => {})
      await adminPool`DELETE FROM spaces WHERE tenant_id = ${other}`.catch(() => {})
      await adminPool`DELETE FROM tenants WHERE id = ${other}`.catch(() => {})
    }
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
