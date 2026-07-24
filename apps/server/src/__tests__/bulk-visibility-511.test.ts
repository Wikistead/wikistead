// #511 / ADR-185 (slice 3): bulk page VISIBILITY. Same load-bearing invariant as delete and publish — a
// bulk op is NOT a bulk BYPASS: every page re-runs the same per-page `share` gate the single-page route
// does, a page the caller may not touch is SKIPPED and keeps its visibility, and the answer is a
// partial-success map. Two things are specific to this verb and pinned here: the private marker must be
// written as a PAIR (a lone `user:*` leaves share-link guests reading a "private" page — #244), and the
// skip reason must not tell a member holding a UUID whether a page exists-but-is-forbidden.
// Real Postgres + OpenFGA + Fastify (the bulk call runs the real setPagePrivate / FGA writes).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { check, fgaClient, writeTuples } from '@wikistead/authz'
import { createSpace, deleteSpace } from '../routes/spaces.js'
import { createPage, deletePage, publishPage, setPagePrivate, bulkSetPageVisibility, BULK_VISIBILITY_CAP } from '../routes/pages.js'
import { buildApp } from '../app.js'
import type { Tenant } from '@wikistead/types'

const adminPool = postgres(process.env.DATABASE_ADMIN_URL!)
const TENANT = 'tenant_dev'
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'free', isolation: 'logical' }) as Tenant
const CALLER = 'dev-user'          // space creator ⇒ manager ⇒ holds `share` on its pages
const OTHER = 'bulk-vis-other'     // owns a private page the caller must NOT be able to touch

let app: FastifyInstance
let tenant: Tenant
let db: TenantDb
let spaceId: string
const ids: string[] = []

async function mkPage(title: string, userId = CALLER): Promise<string> {
  const p = await createPage(db, fgaClient, app.searchDriver, { tenantId: tenant.id, spaceId, userId, title })
  ids.push(p.id)
  return p.id
}
// The private predicate the rest of the system keys on (readPagePrivate / doc-builder use user:*).
const privateMarkers = async (id: string): Promise<string[]> => {
  const { tuples } = await fgaClient.read({ object: `page:${id}`, relation: 'private' })
  return (tuples ?? []).map((t) => t.key?.user ?? '').filter(Boolean).sort()
}

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
  tenant = asTenant(TENANT)
  db = await acquireTenantDb(tenant)
  spaceId = (await createSpace(db, fgaClient, { tenantId: tenant.id, userId: CALLER, plan: tenant.plan, name: 'bulk-vis' })).id
}, 60_000)

afterAll(async () => {
  for (const id of ids) await deletePage(db, fgaClient, app.searchDriver, { pageId: id, userId: CALLER }).catch(() => {})
  await deleteSpace(db, fgaClient, app.searchDriver, { tenantId: tenant.id, spaceId, userId: CALLER }).catch(() => {})
  await adminPool`DELETE FROM members WHERE sub = ${OTHER}`.catch(() => {})
  await db.release(); await app.close(); await adminPool.end(); await pool.end()
}, 60_000)

describe('#511 bulkSetPageVisibility — per-page authz is re-run, never bypassed', () => {
  it('privatises what the caller may, SKIPS what they may not, and leaves the skipped page as it was', async () => {
    const a = await mkPage('vis-A')
    const b = await mkPage('vis-B')
    // C belongs to OTHER.corrected the premise here: it is out of the caller's reach BEFORE private
    // even enters it — an unpublished draft has no `page#space` tuple, so space inheritance never starts.
    // That still pins the 403 -> not_found fold (which is what this case is for); the separate claim that
    // "private itself cuts the space manager off" is pinned by the one-way-door case below, on a PUBLISHED
    // page where space inheritance demonstrably was reaching the caller first.
    await writeTuples(fgaClient, [{ user: `user:${OTHER}`, relation: 'editor_member', object: `space:${spaceId}` }])
    const c = await mkPage('vis-C', OTHER)
    await setPagePrivate(db, fgaClient, app.searchDriver, { pageId: c, tenantId: tenant.id, userId: OTHER })
    const cBefore = await privateMarkers(c)

    const res = await bulkSetPageVisibility(db, fgaClient, app.searchDriver, {
      spaceId, pageIds: [a, b, c], makePrivate: true, tenantId: tenant.id, userId: CALLER,
    })
    expect(res.changed).toBe(2)
    expect(res.skipped).toBe(1)
    expect(res.results.find((r) => r.id === a)).toMatchObject({ ok: true })
    expect(res.results.find((r) => r.id === b)).toMatchObject({ ok: true })
    // ANTI-ORACLE: a same-space page the caller cannot `share` reports the SAME reason an absent id gets.
    expect(res.results.find((r) => r.id === c)).toMatchObject({ ok: false, reason: 'not_found' })
    expect(await privateMarkers(c), 'the untouchable page is left exactly as it was').toEqual(cBefore)
  })

  it('writes the private marker as a PAIR, so a share-link guest cannot read a private page (#244)', async () => {
    const p = await mkPage('vis-pair')
    await bulkSetPageVisibility(db, fgaClient, app.searchDriver, {
      spaceId, pageIds: [p], makePrivate: true, tenantId: tenant.id, userId: CALLER,
    })
    // A lone `user:*` would leave share_link principals outside the `but not private` cut — the #244 leak.
    expect(await privateMarkers(p)).toEqual(['share_link:*', 'user:*'])
  })

  it('clears private again (the verb is reversible) and reports partial success uniformly', async () => {
    const p = await mkPage('vis-clear')
    await bulkSetPageVisibility(db, fgaClient, app.searchDriver, { spaceId, pageIds: [p], makePrivate: true, tenantId: tenant.id, userId: CALLER })
    expect(await privateMarkers(p)).toHaveLength(2)
    const res = await bulkSetPageVisibility(db, fgaClient, app.searchDriver, {
      spaceId, pageIds: [p, '00000000-0000-0000-0000-000000000000'], makePrivate: false, tenantId: tenant.id, userId: CALLER,
    })
    expect(res.changed).toBe(1)
    expect(res.results.find((r) => r.id !== p), 'an absent id reports the same uniform reason')
      .toMatchObject({ ok: false, reason: 'not_found' })
    expect(await privateMarkers(p), 'the marker pair is gone').toEqual([])
  })

  it('a page in ANOTHER space is not touched through this space (scope is not a suggestion)', async () => {
    const other = (await createSpace(db, fgaClient, { tenantId: tenant.id, userId: CALLER, plan: tenant.plan, name: 'bulk-vis-elsewhere' })).id
    try {
      const p = await createPage(db, fgaClient, app.searchDriver, { tenantId: tenant.id, spaceId: other, userId: CALLER, title: 'elsewhere' })
      ids.push(p.id)
      const res = await bulkSetPageVisibility(db, fgaClient, app.searchDriver, {
        spaceId, pageIds: [p.id], makePrivate: true, tenantId: tenant.id, userId: CALLER,
      })
      expect(res.results[0]).toMatchObject({ ok: false, reason: 'not_found' })
      expect(await privateMarkers(p.id), 'untouched').toEqual([])
    } finally {
      await deleteSpace(db, fgaClient, app.searchDriver, { tenantId: tenant.id, spaceId: other, userId: CALLER }).catch(() => {})
    }
  })

  it('a caller who cannot view the SPACE gets a uniform 404 for the whole request (no per-item map)', async () => {
    await expect(bulkSetPageVisibility(db, fgaClient, app.searchDriver, {
      spaceId, pageIds: [], makePrivate: true, tenantId: tenant.id, userId: 'bulk-vis-stranger',
    })).rejects.toMatchObject({ statusCode: 404 })
  })

  // #511— the ONE-WAY DOOR. This is the fact the UI's confirm exists for, so it is pinned rather than
  // described: privatising a PUBLISHED page belonging to someone else takes the caller's own `share` away
  // (`share_from_space: sharer from space but not private`), and tenant admin sits inside that same
  // subtraction. Before the private write the caller reaches the page through the space; after it, they
  // cannot clear what they just set. If the model ever stops cutting the actor off, this goes red and the
  // confirm's wording must be revisited — it would then be overstating the consequence.
  it('privatising a published page owned by someone else LOCKS THE CALLER OUT of undoing it', async () => {
    const p = await createPage(db, fgaClient, app.searchDriver, { tenantId: tenant.id, spaceId, userId: OTHER, title: 'one-way' })
    ids.push(p.id)
    await publishPage(db, fgaClient, app.searchDriver, app.storageDriver, { pageId: p.id, subject: `user:${OTHER}`, createdBy: `user:${OTHER}` })
    // Space inheritance IS reaching the caller at this point — otherwise the privatise below would be a
    // permission skip and would pin nothing.
    expect(await check(fgaClient, `user:${CALLER}`, 'share', { type: 'page', id: p.id }), 'reachable via the space before').toBe(true)

    const set = await bulkSetPageVisibility(db, fgaClient, app.searchDriver, {
      spaceId, pageIds: [p.id], makePrivate: true, tenantId: tenant.id, userId: CALLER,
    })
    expect(set.changed).toBe(1)
    expect(await check(fgaClient, `user:${CALLER}`, 'share', { type: 'page', id: p.id }), 'the actor cut themselves off').toBe(false)

    const undo = await bulkSetPageVisibility(db, fgaClient, app.searchDriver, {
      spaceId, pageIds: [p.id], makePrivate: false, tenantId: tenant.id, userId: CALLER,
    })
    expect(undo.results[0]).toMatchObject({ ok: false, reason: 'not_found' })
    expect(await privateMarkers(p.id), 'still private — the actor cannot undo it').toHaveLength(2)
    // Only the page's own direct holder can. (Left cleared so afterAll's delete runs as CALLER.)
    const byOwner = await bulkSetPageVisibility(db, fgaClient, app.searchDriver, {
      spaceId, pageIds: [p.id], makePrivate: false, tenantId: tenant.id, userId: OTHER,
    })
    expect(byOwner.results[0]).toMatchObject({ ok: true })
  })

  // #511— IDEMPOTENT. OpenFGA fails a batch write on an existing tuple, so the second privatise used
  // to surface as `{ok:false, reason:'policy'}` and the toast blamed permissions for it. Re-running must be
  // a no-op that says so, distinct from a page the caller genuinely may not touch.
  it('a page ALREADY in the requested state is a no-op, not a permission skip', async () => {
    const p = await mkPage('vis-idem')
    const first = await bulkSetPageVisibility(db, fgaClient, app.searchDriver, { spaceId, pageIds: [p], makePrivate: true, tenantId: tenant.id, userId: CALLER })
    expect(first).toMatchObject({ changed: 1, unchanged: 0, skipped: 0 })

    const again = await bulkSetPageVisibility(db, fgaClient, app.searchDriver, { spaceId, pageIds: [p], makePrivate: true, tenantId: tenant.id, userId: CALLER })
    expect(again).toMatchObject({ changed: 0, unchanged: 1, skipped: 0 })
    expect(again.results[0]).toMatchObject({ ok: true, noop: true })
    expect(await privateMarkers(p), 'the pair survives the re-run intact').toEqual(['share_link:*', 'user:*'])

    // Same on the clearing side: a page that was never private is unchanged, never counted as changed.
    const q = await mkPage('vis-idem-clear')
    const clear = await bulkSetPageVisibility(db, fgaClient, app.searchDriver, { spaceId, pageIds: [q], makePrivate: false, tenantId: tenant.id, userId: CALLER })
    expect(clear).toMatchObject({ changed: 0, unchanged: 1, skipped: 0 })
  })

  // #511— parent + child selected together. private cascades DOWN the parent chain, so the child is
  // effectively private the moment the parent is. Its own marker is still a real write (it outlives the
  // parent being cleared), so it must count as changed, and clearing only the parent must not leave the
  // child looking public when it still carries its own marker.
  it('selecting a parent AND its child privatises each on its own terms', async () => {
    const parent = await mkPage('vis-parent')
    const child = await createPage(db, fgaClient, app.searchDriver, { tenantId: tenant.id, spaceId, userId: CALLER, title: 'vis-child', parentId: parent })
    ids.push(child.id)

    const res = await bulkSetPageVisibility(db, fgaClient, app.searchDriver, {
      spaceId, pageIds: [parent, child.id], makePrivate: true, tenantId: tenant.id, userId: CALLER,
    })
    expect(res).toMatchObject({ changed: 2, unchanged: 0, skipped: 0 })
    expect(await privateMarkers(child.id), 'the child holds its OWN pair, not just inherited privacy').toEqual(['share_link:*', 'user:*'])

    // Clearing the parent alone leaves the child private by its own marker — no silent re-exposure.
    await bulkSetPageVisibility(db, fgaClient, app.searchDriver, { spaceId, pageIds: [parent], makePrivate: false, tenantId: tenant.id, userId: CALLER })
    expect(await privateMarkers(child.id)).toEqual(['share_link:*', 'user:*'])
  })

  it('the selection cap is enforced', async () => {
    const tooMany = Array.from({ length: BULK_VISIBILITY_CAP + 1 }, (_, i) => `id-${i}`)
    await expect(bulkSetPageVisibility(db, fgaClient, app.searchDriver, {
      spaceId, pageIds: tooMany, makePrivate: true, tenantId: tenant.id, userId: CALLER,
    })).rejects.toMatchObject({ statusCode: 400, reason: 'too_many' })
  })
})
