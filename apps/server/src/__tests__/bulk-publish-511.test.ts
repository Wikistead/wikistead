// #511 / ADR-185 (slice 2): bulk page PUBLISH. Like bulk delete, the load-bearing invariant is that a bulk
// op is NOT a bulk BYPASS — every page re-runs the same per-page `publish` gate the single /publish route
// does, a page the caller cannot publish is skipped and LEFT UNPUBLISHED, and the response is a
// partial-success map (not all-or-nothing). Real Postgres + OpenFGA + Fastify (bulkPublishPages calls the
// real publishPage / FGA checks / revision write).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import * as Y from 'yjs'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { fgaClient, writeTuples } from '@wikistead/authz'
import { createSpace, deleteSpace } from '../routes/spaces.js'
import { createPage, deletePage, setPagePrivate, bulkPublishPages, BULK_PUBLISH_CAP } from '../routes/pages.js'
import { buildApp } from '../app.js'
import type { Tenant } from '@wikistead/types'

const adminPool = postgres(process.env.DATABASE_ADMIN_URL!)
const TENANT = 'tenant_dev'
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'free', isolation: 'logical' }) as Tenant
const CALLER = 'dev-user' // space creator ⇒ manager ⇒ may publish its pages
const OTHER = 'bulk-pub-other' // owns a private page the caller must NOT be able to publish
const STRANGER = 'bulk-pub-stranger' // no reach into the space

let app: FastifyInstance
let tenant: Tenant
let db: TenantDb
let spaceId: string
let otherSpaceId: string
const ids: string[] = []

// A collab draft save: persist a ydoc body so publish snapshots real content (a revision, not a no-op).
const setDraft = (pageId: string, text: string) =>
  adminPool`UPDATE pages SET ydoc = ${Buffer.from(Y.encodeStateAsUpdate((() => { const d = new Y.Doc(); d.getText('content').insert(0, text); return d })()))}, has_unpublished_changes = true WHERE id = ${pageId}`

async function mkDraft(title: string, userId = CALLER, space = spaceId): Promise<string> {
  const p = await createPage(db, fgaClient, app.searchDriver, { tenantId: tenant.id, spaceId: space, userId, title })
  ids.push(p.id)
  await setDraft(p.id, `# ${title}\n\nbody of ${title}\n`)
  return p.id
}
const publishedAt = async (id: string): Promise<Date | null> => {
  const [r] = await adminPool<[{ published_at: Date | null }?]>`SELECT published_at FROM pages WHERE id = ${id}`
  return r?.published_at ?? null
}

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
  tenant = asTenant(TENANT)
  db = await acquireTenantDb(tenant)
  spaceId = (await createSpace(db, fgaClient, { tenantId: tenant.id, userId: CALLER, plan: tenant.plan, name: 'bulk-pub' })).id
  otherSpaceId = (await createSpace(db, fgaClient, { tenantId: tenant.id, userId: CALLER, plan: tenant.plan, name: 'bulk-pub-other' })).id
}, 60_000)

afterAll(async () => {
  for (const id of ids) await deletePage(db, fgaClient, app.searchDriver, { pageId: id, userId: CALLER }).catch(() => {})
  await deleteSpace(db, fgaClient, app.searchDriver, { tenantId: tenant.id, spaceId, userId: CALLER }).catch(() => {})
  await deleteSpace(db, fgaClient, app.searchDriver, { tenantId: tenant.id, spaceId: otherSpaceId, userId: CALLER }).catch(() => {})
  await db.release()
  await app.close()
  await adminPool.end()
  await pool.end()
}, 60_000)

describe('#511 bulkPublishPages — per-page authz is re-run, never bypassed', () => {
  it('publishes what the caller may, SKIPS a page they may not publish, leaving it unpublished', async () => {
    const a = await mkDraft('A')
    const b = await mkDraft('B')
    // C is owned by OTHER and made private, so the CALLER's space-manage no longer reaches it ⇒ no publish.
    // OTHER needs space edit to create it (createPage's edit gate); grant the writable editor leaf.
    await writeTuples(fgaClient, [{ user: `user:${OTHER}`, relation: 'editor_member', object: `space:${spaceId}` }])
    const c = await mkDraft('C', OTHER)
    await setPagePrivate(db, fgaClient, app.searchDriver, { pageId: c, tenantId: tenant.id, userId: OTHER })

    // Anti-oracle: with C private, the caller cannot publish it — and the skip reason is the UNIFORM
    // 'not_found', NOT 'error'. A same-space forbidden page (403) and a nonexistent id must be
    // indistinguishable (RLS is tenant-scoped, so a forbidden page still reaches the per-item gate).
    await expect(bulkPublishPages(db, fgaClient, app.searchDriver, app.storageDriver, { spaceId, pageIds: [c], userId: CALLER }))
      .resolves.toMatchObject({ published: 0, skipped: 1, results: [{ id: c, ok: false, reason: 'not_found' }] })
    expect(await publishedAt(c), 'the un-publishable page is untouched').toBeNull()

    const res = await bulkPublishPages(db, fgaClient, app.searchDriver, app.storageDriver, { spaceId, pageIds: [a, b, c], userId: CALLER })
    expect(res.published).toBe(2)
    expect(res.skipped).toBe(1)
    expect(res.results.find((r) => r.id === a)).toMatchObject({ ok: true })
    expect(res.results.find((r) => r.id === b)).toMatchObject({ ok: true })
    expect(res.results.find((r) => r.id === c)).toMatchObject({ ok: false, reason: 'not_found' })
    expect(await publishedAt(a), 'the caller\'s page transitioned draft → published').not.toBeNull()
    expect(await publishedAt(b)).not.toBeNull()
    expect(await publishedAt(c), 'a page the caller cannot publish is NEVER touched by the batch').toBeNull()
  })

  it('a page from ANOTHER space is skipped (not_found) and untouched — the op is space-scoped', async () => {
    const mine = await mkDraft('scoped-mine')
    const elsewhere = await mkDraft('scoped-elsewhere', CALLER, otherSpaceId)
    const res = await bulkPublishPages(db, fgaClient, app.searchDriver, app.storageDriver, { spaceId, pageIds: [mine, elsewhere], userId: CALLER })
    expect(res.results.find((r) => r.id === elsewhere)).toMatchObject({ ok: false, reason: 'not_found' })
    expect(await publishedAt(elsewhere), 'a different space\'s page is never touched').toBeNull()
    expect(await publishedAt(mine)).not.toBeNull()
  })

  it('a caller who cannot even view the space gets a uniform 404 (no per-item oracle)', async () => {
    const p = await mkDraft('gate-probe')
    await expect(bulkPublishPages(db, fgaClient, app.searchDriver, app.storageDriver, { spaceId, pageIds: [p], userId: STRANGER }))
      .rejects.toMatchObject({ statusCode: 404 })
    expect(await publishedAt(p)).toBeNull()
  })

  it('the selection cap is enforced (bounded work / body size)', async () => {
    const tooMany = Array.from({ length: BULK_PUBLISH_CAP + 1 }, (_, i) => `p${i}`)
    await expect(bulkPublishPages(db, fgaClient, app.searchDriver, app.storageDriver, { spaceId, pageIds: tooMany, userId: CALLER }))
      .rejects.toMatchObject({ statusCode: 400, reason: 'too_many' })
  })
})
