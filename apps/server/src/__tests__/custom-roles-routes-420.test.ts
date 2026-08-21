// #420 / ADR-164 increment 3b: route gates ride the SPLIT VERBS. Anti-tests (positive+negative per
// Rider 2's instruction):
//  (1) a delete-only principal runs the full trash lifecycle (trash → listed → restore → purge)
//      but cannot grant access or publish.
//  (2) a share-only principal grants/revokes/lists/restricts and issues page links but cannot trash.
//  (3) a publish-only principal publishes a draft but cannot trash or grant.
//  (4) Rider 2 — every share-class operation answers the uniform 404 on a TRASHED page, and works
//      again after restore.
//  (5) manager non-regression: the superset still passes every gate (plus the whole existing suite).
// Real Postgres + OpenFGA.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { fgaClient, check, writeTuples, deleteTuples } from '@wikistead/authz'
import { pool } from '../db/pool.js'
import { ensureMembers } from './helpers/membership.js'
import { TenantRegistry } from '../db/registry.js'
import { acquireTenantDb } from '../db/tenant-db.js'
import type { TenantDb } from '../db/index.js'
import { LogicalSearchDriver } from '../search/index.js'
import { LogicalStorageDriver } from '../storage/index.js'
import { createSpace, deleteSpace } from '../routes/spaces.js'
import {
  createPage, publishPage, trashPage, restorePage, purgePage, listSpaceTrash,
  grantPageAccess, revokePageAccess, listAllPageAccess, restrictPageAccess, listAllPageRestrictions,
  unrestrictPageAccess, isPagePrivate,
} from '../routes/pages.js'
import { createShareLink, listShareLinks, revokeShareLink } from '../routes/share-links.js'
import type { Tenant } from '@wikistead/types'

const driver = new LogicalSearchDriver()
const storage = new LogicalStorageDriver()

let tenant: Tenant
let db: TenantDb
let spaceId: string
const P = (id: string) => ({ type: 'page' as const, id })
const S = (id: string) => ({ type: 'space' as const, id })
const DEL = 'crr420-deleter'
const SHR = 'crr420-sharer'
const PUB = 'crr420-publisher'
// #868: a MEMBER of the tenant holding none of the split verbs. The share-class assertions below need
// both directions, and the refused direction says nothing if its subject is a stranger — a stranger is
// refused by membership, whatever the gate asks. Seated in beforeAll for that reason.
const NOB = 'crr420-nobody'

async function makePage(title: string): Promise<string> {
  const p = await createPage(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user', title })
  return p.id
}

beforeAll(async () => {
  tenant = (await new TenantRegistry(pool).findBySlug('dev'))!
  db = await acquireTenantDb(tenant)
  await ensureMembers(tenant.id, [NOB]) // #868: the refused subject is inside the tenant, not outside it
  spaceId = (await createSpace(db, fgaClient, { tenantId: tenant.id, userId: 'dev-user', plan: tenant.plan, name: 'crr420' })).id
}, 60_000)

afterAll(async () => {
  await deleteSpace(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user' }).catch(() => {})
  await db.release()
  await pool.end()
}, 60_000)

describe('split-verb route gates (#420 3b)', () => {
  it('(1) delete-only: full trash lifecycle allowed; grant + publish refused', async () => {
    const pageId = await makePage('del-target')
    // page-scoped delete + space viewer (the trash LISTING is space-view-gated — existence hiding
    // for the space; a realistic delete role bundles view, and the space grant supplies it here).
    const grant = { user: `user:${DEL}`, relation: 'delete_direct', object: `page:${pageId}` }
    const viewer = { user: `user:${DEL}`, relation: 'viewer', object: `space:${spaceId}` }
    await writeTuples(fgaClient, [grant, viewer])
    try {
      await expect(grantPageAccess(db, fgaClient, driver, { pageId, tenantId: tenant.id, userId: DEL, grantee: 'user:x', relation: 'view' }))
        .rejects.toMatchObject({ statusCode: 403 })
      await expect(publishPage(db, fgaClient, driver, storage, { pageId, subject: `user:${DEL}`, createdBy: `user:${DEL}` }))
        .rejects.toMatchObject({ statusCode: 403 })
      await trashPage(db, fgaClient, driver, { pageId, userId: DEL })
      const listing = await listSpaceTrash(db, fgaClient, { spaceId, userId: DEL })
      expect(listing.some((e) => e.id === pageId), 'delete-only sees its trash entry').toBe(true)
      await restorePage(db, fgaClient, driver, { pageId, userId: DEL })
      await trashPage(db, fgaClient, driver, { pageId, userId: DEL })
      await purgePage(db, fgaClient, driver, { pageId, userId: DEL })
    } finally {
      await deleteTuples(fgaClient, [grant]).catch(() => {})
      await deleteTuples(fgaClient, [viewer]).catch(() => {})
    }
  })

  it('(2) share-only: grants/restrictions/links allowed; trash refused', async () => {
    const pageId = await makePage('share-target')
    const grant = { user: `user:${SHR}`, relation: 'share_direct', object: `page:${pageId}` }
    await writeTuples(fgaClient, [grant])
    try {
      await grantPageAccess(db, fgaClient, driver, { pageId, tenantId: tenant.id, userId: SHR, grantee: 'user:crr420-guest1', relation: 'view' })
      expect((await listAllPageAccess(fgaClient, db, { pageId, tenantId: tenant.id, userId: SHR })).some((g) => g.grantee === 'user:crr420-guest1')).toBe(true)
      await restrictPageAccess(db, fgaClient, driver, { pageId, tenantId: tenant.id, userId: SHR, principal: 'user:crr420-bad' })
      expect((await listAllPageRestrictions(db, fgaClient, { pageId, userId: SHR })).some((r) => r.principal === 'user:crr420-bad')).toBe(true)
      await unrestrictPageAccess(db, fgaClient, driver, { pageId, tenantId: tenant.id, userId: SHR, principal: 'user:crr420-bad' })
      await revokePageAccess(db, fgaClient, driver, { pageId, tenantId: tenant.id, userId: SHR, grantee: 'user:crr420-guest1', relation: 'view' })
      const link = await createShareLink(db, fgaClient, { tenantId: tenant.id, resource: P(pageId), capability: 'view', userId: SHR, plan: tenant.plan, expiresInSeconds: null })
      expect(link.id).toBeTruthy()
      // #868 / #833: the costliest of the three claims — that READING and REVOKING a resource's links
      // is share-class, not manage-class. Until now it was held up by a text check on the comment that
      // says so; issuing was the only verb any test actually walked. An unpassworded link id is its own
      // credential, so both directions matter: dropped from the implementation this is a lockout, and
      // widened it is a leak of credentials. Asked as SHR — never as dev-user, who owns the space and
      // passes everything, which is why the existing list assertions in this file prove nothing about
      // which verb the gate accepts.
      expect((await listShareLinks(db, fgaClient, { resource: P(pageId), userId: SHR })).links.some((l) => l.id === link.id)).toBe(true)
      await expect(listShareLinks(db, fgaClient, { resource: P(pageId), userId: NOB })).rejects.toMatchObject({ statusCode: 403 })
      await expect(revokeShareLink(db, fgaClient, { id: link.id, userId: NOB, tenantId: tenant.id })).rejects.toMatchObject({ statusCode: 403 })
      await revokeShareLink(db, fgaClient, { id: link.id, userId: SHR, tenantId: tenant.id })
      expect((await listShareLinks(db, fgaClient, { resource: P(pageId), userId: SHR })).links.some((l) => l.id === link.id)).toBe(false)
      await expect(trashPage(db, fgaClient, driver, { pageId, userId: SHR })).rejects.toMatchObject({ statusCode: 403 })
    } finally {
      await deleteTuples(fgaClient, [grant]).catch(() => {})
      await trashPage(db, fgaClient, driver, { pageId, userId: 'dev-user' }).catch(() => {})
    }
  })

  it("(2s) share-only on a SPACE: `sharer` alone lists and revokes the space's links (#868)", async () => {
    // The space surface takes a different road to the same gate: `share` resolves to the space's
    // `sharer` relation, which — unlike the page's `share` — unions no manager arm, so the gate
    // accepts share OR manage there. That second arm is why the space side needs its own case: a
    // change that left only the manage arm standing would keep every page assertion above green.
    const grant = { user: `user:${SHR}`, relation: 'sharer', object: `space:${spaceId}` }
    await writeTuples(fgaClient, [grant])
    let link: { id: string } | null = null
    try {
      link = await createShareLink(db, fgaClient, { tenantId: tenant.id, resource: S(spaceId), capability: 'view', userId: SHR, plan: tenant.plan, expiresInSeconds: null })
      expect((await listShareLinks(db, fgaClient, { resource: S(spaceId), userId: SHR })).links.some((l) => l.id === link!.id)).toBe(true)
      await expect(listShareLinks(db, fgaClient, { resource: S(spaceId), userId: NOB })).rejects.toMatchObject({ statusCode: 403 })
      await revokeShareLink(db, fgaClient, { id: link.id, userId: SHR, tenantId: tenant.id })
      expect((await listShareLinks(db, fgaClient, { resource: S(spaceId), userId: SHR })).links.some((l) => l.id === link!.id)).toBe(false)
    } finally {
      if (link) await revokeShareLink(db, fgaClient, { id: link.id, userId: 'dev-user', tenantId: tenant.id }).catch(() => {})
      await deleteTuples(fgaClient, [grant]).catch(() => {})
    }
  })

  it('(3) publish-only: publishes a draft; trash + grant refused', async () => {
    const pageId = await makePage('pub-target')
    const grant = { user: `user:${PUB}`, relation: 'publish_direct', object: `page:${pageId}` }
    await writeTuples(fgaClient, [grant])
    try {
      const r = await publishPage(db, fgaClient, driver, storage, { pageId, subject: `user:${PUB}`, createdBy: `user:${PUB}` })
      expect(r.publishedAt).toBeTruthy()
      await expect(trashPage(db, fgaClient, driver, { pageId, userId: PUB })).rejects.toMatchObject({ statusCode: 403 })
      await expect(grantPageAccess(db, fgaClient, driver, { pageId, tenantId: tenant.id, userId: PUB, grantee: 'user:y', relation: 'view' }))
        .rejects.toMatchObject({ statusCode: 403 })
    } finally {
      await deleteTuples(fgaClient, [grant]).catch(() => {})
      await trashPage(db, fgaClient, driver, { pageId, userId: 'dev-user' }).catch(() => {})
    }
  })

  it('(2b) the GRANT CEILING (Addendum 3, strict fork): share-only grants reader/writer relations ONLY — every admin-class grant/revoke needs manage', async () => {
    const pageId = await makePage('ceiling-target')
    const grant = { user: `user:${SHR}`, relation: 'share_direct', object: `page:${pageId}` }
    await writeTuples(fgaClient, [grant])
    try {
      // Reader/writer class: allowed (view / comment / edit).
      for (const relation of ['view', 'comment', 'edit'] as const) {
        await grantPageAccess(db, fgaClient, driver, { pageId, tenantId: tenant.id, userId: SHR, grantee: 'user:crr420-rw', relation })
        await revokePageAccess(db, fgaClient, driver, { pageId, tenantId: tenant.id, userId: SHR, grantee: 'user:crr420-rw', relation })
      }
      // Admin class — INCLUDING share itself (delegation is manage-only, the stricter ruled fork):
      // 403 whether granted to SELF (the escalation) or to others.
      for (const relation of ['manage', 'moderate', 'delete', 'share', 'settings', 'publish'] as const) {
        await expect(grantPageAccess(db, fgaClient, driver, { pageId, tenantId: tenant.id, userId: SHR, grantee: `user:${SHR}`, relation }), `self ${relation}`)
          .rejects.toMatchObject({ statusCode: 403 })
        await expect(grantPageAccess(db, fgaClient, driver, { pageId, tenantId: tenant.id, userId: SHR, grantee: 'user:crr420-other', relation }), `other ${relation}`)
          .rejects.toMatchObject({ statusCode: 403 })
      }
      // A share-only principal cannot strip a manager either (revoke is ceilinged the same way).
      await expect(revokePageAccess(db, fgaClient, driver, { pageId, tenantId: tenant.id, userId: SHR, grantee: 'user:dev-user', relation: 'manage' }))
        .rejects.toMatchObject({ statusCode: 403 })
      // The escalation is REALLY closed: SHR still has no manage on the page.
      expect(await check(fgaClient, `user:${SHR}`, 'manage', P(pageId))).toBe(false)
      // Manager non-regression: manage grants admin-class relations as before.
      await grantPageAccess(db, fgaClient, driver, { pageId, tenantId: tenant.id, userId: 'dev-user', grantee: 'user:crr420-newmgr', relation: 'manage' })
      expect(await check(fgaClient, 'user:crr420-newmgr', 'manage', P(pageId))).toBe(true)
      await revokePageAccess(db, fgaClient, driver, { pageId, tenantId: tenant.id, userId: 'dev-user', grantee: 'user:crr420-newmgr', relation: 'manage' })
    } finally {
      await deleteTuples(fgaClient, [grant]).catch(() => {})
      await trashPage(db, fgaClient, driver, { pageId, userId: 'dev-user' }).catch(() => {})
    }
  })

  it('(4) Rider 2: share-class operations answer the uniform 404 on a trashed page, and recover after restore', async () => {
    const pageId = await makePage('trash-404')
    // Pre-trash: the manager exercises each operation (positive) …
    await grantPageAccess(db, fgaClient, driver, { pageId, tenantId: tenant.id, userId: 'dev-user', grantee: 'user:crr420-pre', relation: 'view' })
    expect(await isPagePrivate(db, fgaClient, { pageId, userId: 'dev-user' })).toBe(false)
    await trashPage(db, fgaClient, driver, { pageId, userId: 'dev-user' })
    // … trashed: every share-class call is a uniform 404 (never 403 — byte-identical to absent).
    const expect404 = (p: Promise<unknown>, label: string) => expect(p, label).rejects.toMatchObject({ statusCode: 404 })
    await expect404(grantPageAccess(db, fgaClient, driver, { pageId, tenantId: tenant.id, userId: 'dev-user', grantee: 'user:z', relation: 'view' }), 'grant')
    await expect404(listAllPageAccess(fgaClient, db, { pageId, tenantId: tenant.id, userId: 'dev-user' }), 'list access')
    await expect404(restrictPageAccess(db, fgaClient, driver, { pageId, tenantId: tenant.id, userId: 'dev-user', principal: 'user:z' }), 'restrict')
    await expect404(isPagePrivate(db, fgaClient, { pageId, userId: 'dev-user' }), 'private read')
    await expect404(createShareLink(db, fgaClient, { tenantId: tenant.id, resource: P(pageId), capability: 'view', userId: 'dev-user', plan: tenant.plan, expiresInSeconds: null }), 'link create')
    // Restore: the operations come back.
    await restorePage(db, fgaClient, driver, { pageId, userId: 'dev-user' })
    expect((await listAllPageAccess(fgaClient, db, { pageId, tenantId: tenant.id, userId: 'dev-user' })).some((g) => g.grantee === 'user:crr420-pre')).toBe(true)
    await trashPage(db, fgaClient, driver, { pageId, userId: 'dev-user' })
    await purgePage(db, fgaClient, driver, { pageId, userId: 'dev-user' })
  })

  it('(5) manager non-regression: the superset passes grant, publish, and the trash lifecycle', async () => {
    const pageId = await makePage('mgr-target')
    await grantPageAccess(db, fgaClient, driver, { pageId, tenantId: tenant.id, userId: 'dev-user', grantee: 'user:crr420-m', relation: 'edit' })
    const r = await publishPage(db, fgaClient, driver, storage, { pageId, subject: 'user:dev-user', createdBy: 'user:dev-user' })
    expect(r.publishedAt).toBeTruthy()
    await trashPage(db, fgaClient, driver, { pageId, userId: 'dev-user' })
    await restorePage(db, fgaClient, driver, { pageId, userId: 'dev-user' })
    expect(await check(fgaClient, 'user:crr420-m', 'edit', P(pageId))).toBe(true)
    await trashPage(db, fgaClient, driver, { pageId, userId: 'dev-user' })
    await purgePage(db, fgaClient, driver, { pageId, userId: 'dev-user' })
  })
})
