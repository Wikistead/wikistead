// #420 / ADR-164 increment 1: the capability VERB SPLIT (delete / share / settings / publish).
// Anti-test matrix per theapproval:
//  - publish BACK-COMPAT (binding condition 2): every existing edit holder (member leaf, space editor,
//    edit share-link guest) publishes; principals holding NO new leaves derive view/comment/edit/manage
//    exactly as before (bit-identical spot checks).
//  - "delete only" works day-1: the leaf grants delete + view (viewable union) and NOTHING else.
//  - composition: space-level capability cascades to published pages, is cut by private, gated by
//    published for folder cascade; admin verbs survive trash (Rider 1: restore/purge authority),
//    publish is subtracted by restricted/frozen/trashed like edit.
//  - guest boundary: the new leaves declare no share_link/user:* types — the MODEL rejects such writes,
//    and the route-level validateGrant rejects them before FGA.
// (Thetuple-REFERENCE-COUNT pin targets the role-assignment engine's unassign path — that code
// lands in increment 2; the pin is written with it.)
// Real OpenFGA (isolated server-test stack; the suite head heals the model from this checkout's model.fga).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { fgaClient, check, writeTuples, deleteTuples } from '@wikistead/authz'
import { pool } from '../db/pool.js'
import { TenantRegistry } from '../db/registry.js'
import { acquireTenantDb } from '../db/tenant-db.js'
import type { TenantDb } from '../db/index.js'
import { LogicalSearchDriver } from '../search/index.js'
import { buildSearchDoc } from '../search/doc-builder.js'
import { createSpace, deleteSpace } from '../routes/spaces.js'
import { createPage, deletePage, grantPageAccess, revokePageAccess } from '../routes/pages.js'
import type { Tenant } from '@wikistead/types'

const driver = new LogicalSearchDriver()

let tenant: Tenant
let db: TenantDb
let spaceId: string
let pageId: string // published page in the space
const P = (id: string) => ({ type: 'page' as const, id })
const pageTuple = (user: string, relation: string, id: string) => ({ user, relation, object: `page:${id}` })

beforeAll(async () => {
  tenant = (await new TenantRegistry(pool).findBySlug('dev'))!
  db = await acquireTenantDb(tenant)
  spaceId = (await createSpace(db, fgaClient, { tenantId: tenant.id, userId: 'dev-user', plan: tenant.plan, name: 'cr420' })).id
  pageId = (await createPage(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user', title: 'verbs' })).id
  // Publish-shape tuples (space link + published pair) so space inheritance and cascade paths exist.
  await writeTuples(fgaClient, [
    { user: `space:${spaceId}`, relation: 'space', object: `page:${pageId}` },
    pageTuple('user:*', 'published', pageId),
    pageTuple('share_link:*', 'published', pageId),
  ])
}, 60_000)

afterAll(async () => {
  await deletePage(db, fgaClient, driver, { pageId, userId: 'dev-user' }).catch(() => {})
  await deleteSpace(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user' }).catch(() => {})
  await db.release()
  await pool.end()
}, 60_000)

describe('publish back-compat (binding condition 2)', () => {
  it('every EXISTING edit path still publishes; no-new-leaf principals derive verbs bit-identically', async () => {
    const editor = 'user:cr420-editor'
    const linkGuest = 'share_link:cr420-elink'
    const tuples = [
      pageTuple(editor, 'edit_direct', pageId),
      pageTuple(linkGuest, 'edit_direct', pageId),
    ]
    await writeTuples(fgaClient, tuples)
    try {
      // edit holders (member + guest link) publish — the edit_live superset feeder.
      expect(await check(fgaClient, editor, 'publish', P(pageId))).toBe(true)
      expect(await check(fgaClient, linkGuest, 'publish', P(pageId))).toBe(true)
      // manage implies all four split verbs (superset, no tuple migration).
      for (const verb of ['delete', 'share', 'settings', 'publish'] as const) {
        expect(await check(fgaClient, 'user:dev-user', verb, P(pageId)), verb).toBe(true)
      }
      // Bit-identical spot checks for a principal with NO new leaves: the editor's classic verbs are
      // unchanged, and the ADMIN verbs stay false (edit never implied delete/share/settings).
      expect(await check(fgaClient, editor, 'edit', P(pageId))).toBe(true)
      expect(await check(fgaClient, editor, 'view', P(pageId))).toBe(true)
      expect(await check(fgaClient, editor, 'manage', P(pageId))).toBe(false)
      for (const verb of ['delete', 'share', 'settings'] as const) {
        expect(await check(fgaClient, editor, verb, P(pageId)), verb).toBe(false)
      }
    } finally {
      await deleteTuples(fgaClient, tuples)
    }
  })
})

describe('the split verbs stand alone', () => {
  it("a DELETE-ONLY grant confers delete + view (viewable union) and nothing else — via the real grant write-path", async () => {
    const u = 'user:cr420-deleter'
    await grantPageAccess(db, fgaClient, driver, { pageId, tenantId: tenant.id, userId: 'dev-user', grantee: u, relation: 'delete' })
    try {
      expect(await check(fgaClient, u, 'delete', P(pageId))).toBe(true)
      expect(await check(fgaClient, u, 'view', P(pageId))).toBe(true) // capability holders see the page
      for (const verb of ['edit', 'manage', 'share', 'settings', 'publish', 'comment'] as const) {
        expect(await check(fgaClient, u, verb, P(pageId)), verb).toBe(false)
      }
    } finally {
      await revokePageAccess(db, fgaClient, driver, { pageId, tenantId: tenant.id, userId: 'dev-user', grantee: u, relation: 'delete' })
      expect(await check(fgaClient, u, 'delete', P(pageId))).toBe(false) // revoke works
    }
  })

  it('space-level capability (sharer) reaches published pages, is CUT by private, and folder-cascades only to published children', async () => {
    const u = 'user:cr420-sharer'
    const spaceTuple = { user: u, relation: 'sharer', object: `space:${spaceId}` }
    await writeTuples(fgaClient, [spaceTuple])
    // A DRAFT page (no published pair, no page#space link written at create) for the cascade gate.
    const draft = await createPage(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user', title: 'draft', parentId: pageId })
    try {
      expect(await check(fgaClient, u, 'share', P(pageId))).toBe(true) // space sharer → published page
      // PRIVATE cuts the space inheritance (ADR-098 no-back-door).
      const privatePair = [pageTuple('user:*', 'private', pageId), pageTuple('share_link:*', 'private', pageId)]
      await writeTuples(fgaClient, privatePair)
      expect(await check(fgaClient, u, 'share', P(pageId))).toBe(false)
      await deleteTuples(fgaClient, privatePair)
      // Folder cascade: a share_direct on the parent reaches a PUBLISHED child only.
      const v = 'user:cr420-cascade'
      // (createPage with parentId already wrote the page#parent tuple — only the leaf is added here.)
      await writeTuples(fgaClient, [pageTuple(v, 'share_direct', pageId)])
      expect(await check(fgaClient, v, 'share', P(draft.id)), 'draft child stays creator-only').toBe(false)
      await writeTuples(fgaClient, [pageTuple('user:*', 'published', draft.id), pageTuple('share_link:*', 'published', draft.id)])
      expect(await check(fgaClient, v, 'share', P(draft.id)), 'published child inherits').toBe(true)
      await deleteTuples(fgaClient, [pageTuple(v, 'share_direct', pageId)])
    } finally {
      await deleteTuples(fgaClient, [spaceTuple]).catch(() => {})
      await deletePage(db, fgaClient, driver, { pageId: draft.id, userId: 'dev-user' }).catch(() => {})
    }
  })

  it('subtraction composition: admin verbs SURVIVE trash (Rider 1 restore/purge authority); publish is cut by restricted, frozen, and trash', async () => {
    const del = 'user:cr420-del2'
    const pub = 'user:cr420-pub'
    await writeTuples(fgaClient, [pageTuple(del, 'delete_direct', pageId), pageTuple(pub, 'publish_direct', pageId)])
    try {
      // publish-only works while the page is live…
      expect(await check(fgaClient, pub, 'publish', P(pageId))).toBe(true)
      expect(await check(fgaClient, pub, 'edit', P(pageId)), 'publish grants no edit').toBe(false)
      // …restricted principal loses publish (per-principal deny)…
      await writeTuples(fgaClient, [pageTuple(pub, 'restricted', pageId)])
      expect(await check(fgaClient, pub, 'publish', P(pageId))).toBe(false)
      await deleteTuples(fgaClient, [pageTuple(pub, 'restricted', pageId)])
      // …a FROZEN page cannot be published (but delete survives — admin class)…
      const frozenPair = [pageTuple('user:*', 'frozen', pageId), pageTuple('share_link:*', 'frozen', pageId)]
      await writeTuples(fgaClient, frozenPair)
      expect(await check(fgaClient, pub, 'publish', P(pageId))).toBe(false)
      expect(await check(fgaClient, del, 'delete', P(pageId))).toBe(true)
      await deleteTuples(fgaClient, frozenPair)
      // …and TRASH cuts publish but never the admin verbs (delete = the restore/purge authority).
      const trashPair = [pageTuple('user:*', 'trashed', pageId), pageTuple('share_link:*', 'trashed', pageId)]
      await writeTuples(fgaClient, trashPair)
      expect(await check(fgaClient, pub, 'publish', P(pageId))).toBe(false)
      expect(await check(fgaClient, del, 'delete', P(pageId))).toBe(true)
      expect(await check(fgaClient, 'user:dev-user', 'settings', P(pageId))).toBe(true) // manage superset too
      await deleteTuples(fgaClient, trashPair)
    } finally {
      await deleteTuples(fgaClient, [pageTuple(del, 'delete_direct', pageId), pageTuple(pub, 'publish_direct', pageId)]).catch(() => {})
    }
  })

  it('search denorm (Rider 3): capability-granted members join the stage-1 viewer set — leaf AND space level', async () => {
    const leafUser = 'user:cr420-denorm-leaf'
    const spaceUser = 'user:cr420-denorm-space'
    await writeTuples(fgaClient, [
      pageTuple(leafUser, 'delete_direct', pageId),
      { user: spaceUser, relation: 'publisher', object: `space:${spaceId}` },
    ])
    try {
      const doc = await buildSearchDoc(pool, fgaClient, pageId, tenant.id)
      expect(doc, 'doc built').toBeTruthy()
      expect(doc!.viewerUsers, 'delete_direct leaf holder denormalised').toContain(leafUser)
      expect(doc!.viewerUsers, 'space publisher denormalised (published, non-private page)').toContain(spaceUser)
    } finally {
      await deleteTuples(fgaClient, [
        pageTuple(leafUser, 'delete_direct', pageId),
        { user: spaceUser, relation: 'publisher', object: `space:${spaceId}` },
      ]).catch(() => {})
    }
  })

  it('guest boundary: the new leaves take NO share_link/user:* — model rejects the write, route rejects the grant', async () => {
    // Model-level: the type system refuses a share_link (or wildcard) subject on every new leaf.
    for (const leaf of ['delete_direct', 'share_direct', 'settings_direct', 'publish_direct']) {
      await expect(writeTuples(fgaClient, [pageTuple('share_link:cr420-x', leaf, pageId)]), leaf).rejects.toThrow()
      await expect(writeTuples(fgaClient, [pageTuple('user:*', leaf, pageId)]), `${leaf} wildcard`).rejects.toThrow()
    }
    // Route-level: validateGrant refuses non-member principals for the new capabilities (400, pre-FGA).
    await expect(
      grantPageAccess(db, fgaClient, driver, { pageId, tenantId: tenant.id, userId: 'dev-user', grantee: 'share_link:cr420-x', relation: 'delete' }),
    ).rejects.toMatchObject({ statusCode: 400 })
    await expect(
      grantPageAccess(db, fgaClient, driver, { pageId, tenantId: tenant.id, userId: 'dev-user', grantee: 'user:*', relation: 'publish' }),
    ).rejects.toMatchObject({ statusCode: 400 })
  })
})
