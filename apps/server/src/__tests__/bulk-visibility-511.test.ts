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
import { fgaClient, writeTuples } from '@wikistead/authz'
import { createSpace, deleteSpace } from '../routes/spaces.js'
import { createPage, deletePage, setPagePrivate, bulkSetPageVisibility, BULK_VISIBILITY_CAP } from '../routes/pages.js'
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
    // C belongs to OTHER and is already private, so the caller's space-manage no longer reaches it.
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

  it('the selection cap is enforced', async () => {
    const tooMany = Array.from({ length: BULK_VISIBILITY_CAP + 1 }, (_, i) => `id-${i}`)
    await expect(bulkSetPageVisibility(db, fgaClient, app.searchDriver, {
      spaceId, pageIds: tooMany, makePrivate: true, tenantId: tenant.id, userId: CALLER,
    })).rejects.toMatchObject({ statusCode: 400, reason: 'too_many' })
  })
})
