// #511 / ADR-185: bulk page delete. The load-bearing invariant is that a bulk op is NOT a bulk BYPASS —
// every page re-runs the same per-page `delete` gate the single-page route does, a page the caller cannot
// delete is skipped and LEFT UNTOUCHED, and the response is a partial-success map (not all-or-nothing).
// Real Postgres + OpenFGA (bulkDeletePages calls the real trashPage / FGA checks).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { TenantRegistry } from '../db/registry.js'
import { acquireTenantDb } from '../db/tenant-db.js'
import type { TenantDb } from '../db/index.js'
import { fgaClient, writeTuples } from '@wikistead/authz'
import { LogicalSearchDriver } from '../search/index.js'
import { createSpace, deleteSpace } from '../routes/spaces.js'
import { createPage, deletePage, setPagePrivate, bulkDeletePages, BULK_DELETE_CAP } from '../routes/pages.js'
import type { Tenant } from '@wikistead/types'

const driver = new LogicalSearchDriver()
const adminPool = postgres(process.env.DATABASE_ADMIN_URL!)
const CALLER = 'dev-user' // space creator ⇒ manager; owns A/B
const OTHER = 'bulk-other-owner' // owns C (a page the caller must NOT be able to delete)
const STRANGER = 'bulk-stranger' // a subject with no reach into the space

let tenant: Tenant
let db: TenantDb
let spaceId: string
let otherSpaceId: string
const ids: string[] = []

async function mkPage(title: string, userId = CALLER, parentId?: string, space = spaceId): Promise<string> {
  const p = await createPage(db, fgaClient, driver, { tenantId: tenant.id, spaceId: space, userId, title, parentId })
  ids.push(p.id)
  return p.id
}
const trashedAt = async (id: string): Promise<Date | null> => {
  const [r] = await adminPool<[{ deleted_at: Date | null }?]>`SELECT deleted_at FROM pages WHERE id = ${id}`
  return r?.deleted_at ?? null
}

beforeAll(async () => {
  tenant = (await new TenantRegistry(pool).findBySlug('dev'))!
  db = await acquireTenantDb(tenant)
  spaceId = (await createSpace(db, fgaClient, { tenantId: tenant.id, userId: CALLER, plan: tenant.plan, name: 'bulk-del' })).id
  otherSpaceId = (await createSpace(db, fgaClient, { tenantId: tenant.id, userId: CALLER, plan: tenant.plan, name: 'bulk-del-other' })).id
}, 60_000)

afterAll(async () => {
  for (const id of ids) await deletePage(db, fgaClient, driver, { pageId: id, userId: CALLER }).catch(() => {})
  await deleteSpace(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: CALLER }).catch(() => {})
  await deleteSpace(db, fgaClient, driver, { tenantId: tenant.id, spaceId: otherSpaceId, userId: CALLER }).catch(() => {})
  await db.release()
  await pool.end()
  await adminPool.end()
}, 60_000)

describe('#511 bulkDeletePages — per-page authz is re-run, never bypassed', () => {
  it('deletes what the caller may, SKIPS what they may not, and leaves the skipped page untouched', async () => {
    const a = await mkPage('A')
    const b = await mkPage('B')
    // C is owned by OTHER and made private, so the CALLER's space-manage no longer reaches it ⇒ no delete.
    // OTHER needs space edit to create it (createPage's edit gate); grant the writable editor leaf.
    await writeTuples(fgaClient, [{ user: `user:${OTHER}`, relation: 'editor_member', object: `space:${spaceId}` }])
    const c = await mkPage('C', OTHER)
    await setPagePrivate(db, fgaClient, driver, { pageId: c, tenantId: tenant.id, userId: OTHER }) // the owner privatises; caller is a manager, not the owner
    // sanity: with C private, the caller cannot delete it — and the skip reason is the UNIFORM
    // 'not_found', NOT 'error'. A same-space forbidden page (403) and a nonexistent id must be
    // indistinguishable, or the reason leaks that the UUID names a real-but-forbidden page (RLS is
    // tenant-scoped, so a forbidden page still reaches the per-item gate). Anti-oracle pin.
    await expect(bulkDeletePages(db, fgaClient, driver, { spaceId, pageIds: [c], userId: CALLER }))
      .resolves.toMatchObject({ deleted: 0, skipped: 1, results: [{ id: c, ok: false, reason: 'not_found' }] })
    expect(await trashedAt(c), 'the un-deletable page is untouched').toBeNull()

    const res = await bulkDeletePages(db, fgaClient, driver, { spaceId, pageIds: [a, b, c], userId: CALLER })
    expect(res.deleted).toBe(2)
    expect(res.skipped).toBe(1)
    expect(res.results.find((r) => r.id === a)).toMatchObject({ ok: true })
    expect(res.results.find((r) => r.id === b)).toMatchObject({ ok: true })
    expect(res.results.find((r) => r.id === c)).toMatchObject({ ok: false }) // skipped, not deleted
    expect(await trashedAt(a)).not.toBeNull()
    expect(await trashedAt(b)).not.toBeNull()
    expect(await trashedAt(c), 'a page the caller cannot delete is NEVER touched by the batch').toBeNull()
  })

  it('the subtree cascades: deleting a parent trashes its children, and a parent+child selection is idempotent', async () => {
    const root = await mkPage('R')
    const child = await mkPage('R-child', CALLER, root)
    const res = await bulkDeletePages(db, fgaClient, driver, { spaceId, pageIds: [root, child], userId: CALLER })
    // both report ok (child was cascaded by the root's delete; its own turn is an idempotent no-op)
    expect(res.results.every((r) => r.ok)).toBe(true)
    expect(await trashedAt(root)).not.toBeNull()
    expect(await trashedAt(child), 'the child rode the parent into the trash (cascade)').not.toBeNull()
  })

  it('a page from ANOTHER space is skipped (not_found) and untouched — the op is space-scoped', async () => {
    const mine = await mkPage('scoped-mine')
    const elsewhere = await mkPage('scoped-elsewhere', CALLER, undefined, otherSpaceId)
    const res = await bulkDeletePages(db, fgaClient, driver, { spaceId, pageIds: [mine, elsewhere], userId: CALLER })
    expect(res.results.find((r) => r.id === elsewhere)).toMatchObject({ ok: false, reason: 'not_found' })
    expect(await trashedAt(elsewhere), 'a different space\'s page is never touched').toBeNull()
    expect(await trashedAt(mine)).not.toBeNull()
  })

  it('a caller who cannot even view the space gets a uniform 404 (no per-item oracle)', async () => {
    const p = await mkPage('gate-probe')
    await expect(bulkDeletePages(db, fgaClient, driver, { spaceId, pageIds: [p], userId: STRANGER }))
      .rejects.toMatchObject({ statusCode: 404 })
    expect(await trashedAt(p)).toBeNull()
  })

  it('the selection cap is enforced (bounded work / body size)', async () => {
    const tooMany = Array.from({ length: BULK_DELETE_CAP + 1 }, (_, i) => `p${i}`)
    await expect(bulkDeletePages(db, fgaClient, driver, { spaceId, pageIds: tooMany, userId: CALLER }))
      .rejects.toMatchObject({ statusCode: 400, reason: 'too_many' })
  })
})
