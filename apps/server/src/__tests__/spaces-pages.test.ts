// Integration tests — real Postgres + real OpenFGA, no mocks.
// Prerequisites: docker compose up -d && pnpm migrate && pnpm fga:bootstrap && pnpm fga:seed
import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { OpenFgaClient } from '@openfga/sdk'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { TenantRegistry } from '../db/registry.js'
import { acquireTenantDb } from '../db/tenant-db.js'
import type { TenantDb } from '../db/index.js'
import { fgaClient, check, checkRelation, writeTuples, deleteTuples, deleteObjectTuples } from '@wikistead/authz'
import { LogicalSearchDriver } from '../search/index.js'
import { createSpace, listSpaces, deleteSpace, updateSpace, setSpaceIconImage, clearSpaceIconImage } from '../routes/spaces.js'
import { createPage, listPages, getPage, deletePage, movePage } from '../routes/pages.js'
import type { StorageDriver } from '../storage/index.js'
import type { Tenant } from '@wikistead/types'

const driver = new LogicalSearchDriver()

// In-memory storage double for the icon-image tests (no SeaweedFS dependency).
function fakeStorage() {
  const objects = new Map<string, Uint8Array>()
  const deleted: string[] = []
  const storage = {
    putObject: async (key: string, bytes: Uint8Array) => { objects.set(key, bytes) },
    getObject: async (key: string) => objects.get(key) ?? new Uint8Array(),
    deleteObject: async (key: string) => { objects.delete(key); deleted.push(key) },
  } as unknown as StorageDriver
  return { storage, objects, deleted }
}
// A minimal valid PNG (magic bytes are what sniffImage checks).
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]).toString('base64')

// Phase 4 visibility gate: createPage no longer links a page to its space (drafts
// are creator-only); publishing writes `page#space`. Tests that exercise SPACE-
// inheritance behavior (cross-space move, space-scoped share links, space-viewer
// search) operate on PUBLISHED pages, so they link the page to its space first.
const linkToSpace = (pageId: string, spaceId: string) =>
  writeTuples(fgaClient, [{ user: `space:${spaceId}`, relation: 'space', object: `page:${pageId}` }])

let tenant: Tenant
let db: TenantDb

beforeAll(async () => {
  const registry = new TenantRegistry(pool)
  tenant = (await registry.findBySlug('dev'))!
  db = await acquireTenantDb(tenant)
})
afterAll(async () => {
  await db.release()
  await pool.end()
})

// ── RLS: cross-tenant data isolation ──────────────────────────────────────

describe('RLS isolation', () => {
  it('tenant_dev connection cannot see tenant_acme spaces', async () => {
    // Insert a space directly as admin (bypassing RLS) for acme tenant.
    const adminPool = postgres(process.env.DATABASE_ADMIN_URL!)
    const [acmeSpace] = await adminPool<{ id: string }[]>`
      INSERT INTO spaces (tenant_id, name) VALUES ('tenant_acme', 'acme-space-rls-test')
      RETURNING id
    `
    await adminPool.end()

    // The dev tenant connection must NOT see the acme space.
    const rows = await db.sql<{ id: string }[]>`SELECT id FROM spaces WHERE id = ${acmeSpace.id}`
    expect(rows).toHaveLength(0)

    // Cleanup via admin pool.
    const ap2 = postgres(process.env.DATABASE_ADMIN_URL!)
    await ap2`DELETE FROM spaces WHERE id = ${acmeSpace.id}`
    await ap2.end()
  })

  it('tenant_dev connection cannot see tenant_acme pages', async () => {
    const adminPool = postgres(process.env.DATABASE_ADMIN_URL!)
    const [acmeSpace] = await adminPool<{ id: string }[]>`
      INSERT INTO spaces (tenant_id, name) VALUES ('tenant_acme', 'acme-space-for-pages-rls-test')
      RETURNING id
    `
    const [acmePage] = await adminPool<{ id: string }[]>`
      INSERT INTO pages (tenant_id, space_id, title) VALUES ('tenant_acme', ${acmeSpace.id}, 'acme-page-rls-test')
      RETURNING id
    `
    await adminPool.end()

    const rows = await db.sql<{ id: string }[]>`SELECT id FROM pages WHERE id = ${acmePage.id}`
    expect(rows).toHaveLength(0)

    const ap2 = postgres(process.env.DATABASE_ADMIN_URL!)
    await ap2`DELETE FROM spaces WHERE id = ${acmeSpace.id}`
    await ap2.end()
  })
})

// ── Space CRUD + FGA tuples ────────────────────────────────────────────────

describe('space lifecycle', () => {
  it('createSpace writes FGA tuples and returns the space', async () => {
    const space = await createSpace(db, fgaClient, {
      tenantId: tenant.id, userId: 'dev-user', plan: tenant.plan, name: 'test-space',
    })
    expect(space.tenantId).toBe(tenant.id)

    // Verify FGA tuples were written (structural checks use checkRelation, not check).
    // 'tenant' and 'manager' are raw FGA relation names, not Capability values.
    expect(await checkRelation(fgaClient, `tenant:${tenant.id}`, 'tenant',  { type: 'space', id: space.id })).toBe(true)
    expect(await checkRelation(fgaClient, 'user:dev-user',        'manager', { type: 'space', id: space.id })).toBe(true)
    // Capability-level check: 'manage' maps to 'manager' for space internally.
    expect(await check(fgaClient, 'user:dev-user', 'manage', { type: 'space', id: space.id })).toBe(true)

    // Cleanup
    await deleteSpace(db, fgaClient, driver, { tenantId: tenant.id, spaceId: space.id, userId: 'dev-user' })
  })

  it('updateSpace renames with manage authority; a non-manager is rejected', async () => {
    const space = await createSpace(db, fgaClient, { tenantId: tenant.id, userId: 'dev-user', plan: tenant.plan, name: 'old-name' })
    // manager (creator) can rename
    const renamed = await updateSpace(db, fgaClient, { spaceId: space.id, userId: 'dev-user', name: 'new-name' })
    expect(renamed.name).toBe('new-name')
    const [row] = await db.sql<{ name: string }[]>`SELECT name FROM spaces WHERE id = ${space.id}`
    expect(row.name).toBe('new-name')
    // a user without manage on the space is rejected (UI hides it; this is the fortress)
    await expect(updateSpace(db, fgaClient, { spaceId: space.id, userId: 'space-rando', name: 'hijack' })).rejects.toMatchObject({ statusCode: 403 })
    await deleteSpace(db, fgaClient, driver, { tenantId: tenant.id, spaceId: space.id, userId: 'dev-user' })
  })

  it('deleteSpace removes DB row and all FGA tuples', async () => {
    const space = await createSpace(db, fgaClient, {
      tenantId: tenant.id, userId: 'dev-user', plan: tenant.plan, name: 'delete-me-space',
    })
    const spaceId = space.id
    await deleteSpace(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user' })

    const rows = await db.sql`SELECT id FROM spaces WHERE id = ${spaceId}`
    expect(rows).toHaveLength(0)
    expect(await check(fgaClient, 'user:dev-user', 'manage', { type: 'space', id: spaceId })).toBe(false)
  })

  it('setSpaceIconImage: manage-gated, sniffs type (SVG rejected), caps size; listSpaces exposes the URL', async () => {
    const { storage, deleted } = fakeStorage()
    const space = await createSpace(db, fgaClient, { tenantId: tenant.id, userId: 'dev-user', plan: tenant.plan, name: 'img-space' })
    // default: no image → null
    let mine = (await listSpaces(db, fgaClient, 'dev-user')).find((s) => s.id === space.id)
    expect(mine?.iconImageUrl ?? null).toBeNull()
    // a manager uploads a PNG → stored + URL exposed (relative API path)
    await setSpaceIconImage(db, fgaClient, storage, { spaceId: space.id, tenantId: tenant.id, userId: 'dev-user', dataBase64: PNG })
    mine = (await listSpaces(db, fgaClient, 'dev-user')).find((s) => s.id === space.id)
    expect(mine?.iconImageUrl).toBe(`/spaces/${space.id}/icon-image`)
    // a non-manager is rejected (the fortress)
    await expect(setSpaceIconImage(db, fgaClient, storage, { spaceId: space.id, tenantId: tenant.id, userId: 'space-rando', dataBase64: PNG })).rejects.toMatchObject({ statusCode: 403 })
    // SVG is rejected (public asset → would be a stored-XSS vector)
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>').toString('base64')
    await expect(setSpaceIconImage(db, fgaClient, storage, { spaceId: space.id, tenantId: tenant.id, userId: 'dev-user', dataBase64: svg })).rejects.toMatchObject({ statusCode: 400 })
    // empty → 400, oversized (>512KB) → 413
    await expect(setSpaceIconImage(db, fgaClient, storage, { spaceId: space.id, tenantId: tenant.id, userId: 'dev-user', dataBase64: '' })).rejects.toMatchObject({ statusCode: 400 })
    const huge = Buffer.alloc(512 * 1024 + 16).toString('base64')
    await expect(setSpaceIconImage(db, fgaClient, storage, { spaceId: space.id, tenantId: tenant.id, userId: 'dev-user', dataBase64: huge })).rejects.toMatchObject({ statusCode: 413 })
    // clear → URL null + the stored object is deleted
    await clearSpaceIconImage(db, fgaClient, storage, { spaceId: space.id, tenantId: tenant.id, userId: 'dev-user' })
    mine = (await listSpaces(db, fgaClient, 'dev-user')).find((s) => s.id === space.id)
    expect(mine?.iconImageUrl ?? null).toBeNull()
    expect(deleted.length).toBeGreaterThanOrEqual(1)
    // a non-manager cannot clear either
    await expect(clearSpaceIconImage(db, fgaClient, storage, { spaceId: space.id, tenantId: tenant.id, userId: 'space-rando' })).rejects.toMatchObject({ statusCode: 403 })
    await deleteSpace(db, fgaClient, driver, { tenantId: tenant.id, spaceId: space.id, userId: 'dev-user' })
  })

  it('FGA write failure rolls back DB INSERT (no ghost space)', async () => {
    const badFga = new OpenFgaClient({
      apiUrl: 'http://127.0.0.1:9999',         // nothing listening
      storeId: '01H5M3YCPQ3ZHWT1J8RYATM4WN',
    })
    const name = `rollback-test-${Date.now()}`
    await expect(
      createSpace(db, badFga, { tenantId: tenant.id, userId: 'dev-user', name, plan: 'pro' }),
    ).rejects.toThrow()

    const rows = await db.sql<{ id: string }[]>`SELECT id FROM spaces WHERE name = ${name}`
    expect(rows).toHaveLength(0)
  })
})

// ── Page CRUD + FGA tuples ─────────────────────────────────────────────────

describe('page lifecycle', () => {
  let spaceId: string

  beforeAll(async () => {
    const space = await createSpace(db, fgaClient, {
      tenantId: tenant.id, userId: 'dev-user', plan: tenant.plan, name: 'page-test-space',
    })
    spaceId = space.id
  })

  afterAll(async () => {
    await deleteSpace(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user' })
  })

  it('createPage writes FGA space tuple and returns the page', async () => {
    const page = await createPage(db, fgaClient, driver, {
      tenantId: tenant.id, spaceId, userId: 'dev-user', title: 'Hello',
    })
    expect(page.spaceId).toBe(spaceId)
    expect(await check(fgaClient, 'user:dev-user', 'view', { type: 'page', id: page.id })).toBe(true)

    await deletePage(db, fgaClient, driver, { pageId: page.id, userId: 'dev-user' })
  })

  it('deletePage removes DB row and FGA tuples including share_link grants', async () => {
    const page = await createPage(db, fgaClient, driver, {
      tenantId: tenant.id, spaceId, userId: 'dev-user', title: 'ToDelete',
    })
    // Simulate a share_link grant on this page
    await writeTuples(fgaClient, [
      { user: 'share_link:page-delete-test-link', relation: 'view', object: `page:${page.id}` },
    ])
    expect(await check(fgaClient, 'share_link:page-delete-test-link', 'view', { type: 'page', id: page.id })).toBe(true)

    await deletePage(db, fgaClient, driver, { pageId: page.id, userId: 'dev-user' })

    const rows = await db.sql`SELECT id FROM pages WHERE id = ${page.id}`
    expect(rows).toHaveLength(0)
    // share_link tuple must also be gone
    expect(await check(fgaClient, 'share_link:page-delete-test-link', 'view', { type: 'page', id: page.id })).toBe(false)
  })

  it('FGA write failure rolls back createPage DB INSERT', async () => {
    const badFga = new OpenFgaClient({
      apiUrl: 'http://127.0.0.1:9999',
      storeId: '01H5M3YCPQ3ZHWT1J8RYATM4WN',
    })
    const title = `rollback-page-${Date.now()}`
    await expect(
      createPage(db, badFga, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user', title }),
    ).rejects.toThrow()

    const rows = await db.sql<{ id: string }[]>`SELECT id FROM pages WHERE title = ${title}`
    expect(rows).toHaveLength(0)
  })
})

// ── nesting / move / reorder (intra-space, phase 3b ①) ─────────────────────

describe('page nesting and ordering', () => {
  let spaceId: string
  beforeAll(async () => {
    const s = await createSpace(db, fgaClient, { tenantId: tenant.id, userId: 'dev-user', plan: tenant.plan, name: 'nesting-space' })
    spaceId = s.id
  })
  afterAll(async () => {
    await deleteSpace(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user' })
  })

  it('creates a nested page and lists it ordered by position', async () => {
    const parent = await createPage(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user', title: 'parent' })
    const a = await createPage(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user', title: 'A', parentId: parent.id })
    const b = await createPage(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user', title: 'B', parentId: parent.id })
    const pages = await listPages(db, fgaClient, { spaceId, userId: 'dev-user' })
    const child = pages.find((p) => p.id === a.id)!
    expect(child.parentId).toBe(parent.id)
    // created in order -> A before B by position
    const kids = pages.filter((p) => p.parentId === parent.id)
    expect(kids.map((k) => k.id)).toEqual([a.id, b.id])
  })

  it('reorders: moving B before A flips their order (single-row position update)', async () => {
    const parent = await createPage(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user', title: 'p2' })
    const a = await createPage(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user', title: 'A2', parentId: parent.id })
    const b = await createPage(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user', title: 'B2', parentId: parent.id })
    await movePage(db, fgaClient, driver, { pageId: b.id, userId: 'dev-user', parentId: parent.id, afterId: null }) // B to first
    const kids = (await listPages(db, fgaClient, { spaceId, userId: 'dev-user' })).filter((p) => p.parentId === parent.id)
    expect(kids.map((k) => k.id)).toEqual([b.id, a.id])
  })

  it('rejects a cycle: cannot nest a page under its own descendant', async () => {
    const root = await createPage(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user', title: 'root' })
    const mid = await createPage(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user', title: 'mid', parentId: root.id })
    await expect(
      movePage(db, fgaClient, driver, { pageId: root.id, userId: 'dev-user', parentId: mid.id, afterId: null }),
    ).rejects.toThrow()
  })

  it('move requires edit on the page', async () => {
    const page = await createPage(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user', title: 'move-authz' })
    await expect(
      movePage(db, fgaClient, driver, { pageId: page.id, userId: 'stranger', parentId: null, afterId: null }),
    ).rejects.toThrow()
  })

  it('delete cascades the subtree and sweeps descendants FGA grants', async () => {
    const parent = await createPage(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user', title: 'del-parent' })
    const child = await createPage(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user', title: 'del-child', parentId: parent.id })
    expect(await check(fgaClient, 'user:dev-user', 'view', { type: 'page', id: child.id })).toBe(true)

    await deletePage(db, fgaClient, driver, { pageId: parent.id, userId: 'dev-user' })

    const rows = await db.sql`SELECT id FROM pages WHERE id IN (${parent.id}, ${child.id})`
    expect(rows).toHaveLength(0) // cascade removed the child too
    // descendant's FGA grant swept (no ghost auth)
    expect(await check(fgaClient, 'user:dev-user', 'view', { type: 'page', id: child.id })).toBe(false)
  })
})

// ── cross-space move (3b ②): subtree + FGA tuple swap per ADR-003 ──────────
//
// Authorization for a page derives solely from its space, so moving a page to
// another space must re-point the `space` grant of the page AND its whole
// subtree. The swap is delete-OLD → add-NEW inside the DB tx (FGA last): a swap
// failure throws and rolls the DB back (no ghost auth), and the only reachable
// intermediate is "grantless = invisible from any space" (never visible-from-both).

describe('cross-space move (security)', () => {
  // The actual space grant on a page (filters out share_link tuples).
  async function spaceGrantOf(pageId: string): Promise<string | null> {
    const { tuples } = await fgaClient.read({ object: `page:${pageId}` })
    const k = (tuples ?? []).map((t) => t.key).find((k) => k?.relation === 'space')
    return k ? k.user : null
  }

  // Inject an FGA failure on the add-NEW write (writes targeting destUser),
  // letting the delete-OLD pass through — to reach the "invisible side".
  function fgaFailingAddTo(destUser: string): OpenFgaClient {
    return new Proxy(fgaClient, {
      get(t, prop, recv) {
        if (prop === 'write') {
          return async (body: { writes?: { user: string }[] }) => {
            if (body?.writes?.some((w) => w.user === destUser)) throw new Error('injected FGA write failure')
            return (t as unknown as { write: (b: unknown) => Promise<unknown> }).write(body)
          }
        }
        const v = Reflect.get(t, prop, recv)
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v
      },
    }) as OpenFgaClient
  }

  let spaceA: string
  let spaceB: string
  beforeAll(async () => {
    spaceA = (await createSpace(db, fgaClient, { tenantId: tenant.id, userId: 'dev-user', plan: tenant.plan, name: 'xmove-A' })).id
    spaceB = (await createSpace(db, fgaClient, { tenantId: tenant.id, userId: 'dev-user', plan: tenant.plan, name: 'xmove-B' })).id
  })
  afterAll(async () => {
    await deleteSpace(db, fgaClient, driver, { tenantId: tenant.id, spaceId: spaceA, userId: 'dev-user' })
    await deleteSpace(db, fgaClient, driver, { tenantId: tenant.id, spaceId: spaceB, userId: 'dev-user' })
  })

  it('moves the whole subtree and swaps every page grant from old to new space', async () => {
    const parent = await createPage(db, fgaClient, driver, { tenantId: tenant.id, spaceId: spaceA, userId: 'dev-user', title: 'x-parent' })
    const child = await createPage(db, fgaClient, driver, { tenantId: tenant.id, spaceId: spaceA, userId: 'dev-user', title: 'x-child', parentId: parent.id })
    await linkToSpace(parent.id, spaceA); await linkToSpace(child.id, spaceA) // published → space-visible

    // A user who can view spaceA (only) sees both pages via `viewer from space`.
    await writeTuples(fgaClient, [{ user: 'user:src-viewer', relation: 'viewer', object: `space:${spaceA}` }])
    expect(await check(fgaClient, 'user:src-viewer', 'view', { type: 'page', id: parent.id })).toBe(true)
    expect(await check(fgaClient, 'user:src-viewer', 'view', { type: 'page', id: child.id })).toBe(true)

    await movePage(db, fgaClient, driver, { pageId: parent.id, userId: 'dev-user', parentId: null, afterId: null, spaceId: spaceB })

    // DB: the whole subtree followed into spaceB; the root is now top-level there.
    const rows = await db.sql<{ id: string; space_id: string; parent_id: string | null }[]>`
      SELECT id, space_id, parent_id FROM pages WHERE id IN (${parent.id}, ${child.id})`
    expect(rows.find((r) => r.id === parent.id)).toMatchObject({ space_id: spaceB, parent_id: null })
    expect(rows.find((r) => r.id === child.id)).toMatchObject({ space_id: spaceB, parent_id: parent.id })

    // FGA: each page's space grant swapped A → B.
    expect(await spaceGrantOf(parent.id)).toBe(`space:${spaceB}`)
    expect(await spaceGrantOf(child.id)).toBe(`space:${spaceB}`)

    // The source-only viewer can no longer see either page (they left its space);
    // dev-user (manager of B) still can.
    expect(await check(fgaClient, 'user:src-viewer', 'view', { type: 'page', id: parent.id })).toBe(false)
    expect(await check(fgaClient, 'user:src-viewer', 'view', { type: 'page', id: child.id })).toBe(false)
    expect(await check(fgaClient, 'user:dev-user', 'view', { type: 'page', id: parent.id })).toBe(true)

    await deleteTuples(fgaClient, [{ user: 'user:src-viewer', relation: 'viewer', object: `space:${spaceA}` }])
    await deletePage(db, fgaClient, driver, { pageId: parent.id, userId: 'dev-user' })
  })

  it('requires manage on the page AND edit on the destination space', async () => {
    const page = await createPage(db, fgaClient, driver, { tenantId: tenant.id, spaceId: spaceA, userId: 'dev-user', title: 'x-authz' })
    await linkToSpace(page.id, spaceA) // published → space editor inherits edit

    // a stranger has neither manage on the page nor edit on B
    await expect(
      movePage(db, fgaClient, driver, { pageId: page.id, userId: 'stranger', parentId: null, afterId: null, spaceId: spaceB }),
    ).rejects.toThrow()

    // an editor of spaceA can `edit` the page but cannot move it OUT (no manage),
    // and has no rights on the destination space B either.
    await writeTuples(fgaClient, [{ user: 'user:a-editor', relation: 'editor', object: `space:${spaceA}` }])
    expect(await check(fgaClient, 'user:a-editor', 'edit', { type: 'page', id: page.id })).toBe(true)
    await expect(
      movePage(db, fgaClient, driver, { pageId: page.id, userId: 'a-editor', parentId: null, afterId: null, spaceId: spaceB }),
    ).rejects.toThrow()

    // the page never left spaceA
    expect((await db.sql<{ space_id: string }[]>`SELECT space_id FROM pages WHERE id = ${page.id}`)[0].space_id).toBe(spaceA)

    await deleteTuples(fgaClient, [{ user: 'user:a-editor', relation: 'editor', object: `space:${spaceA}` }])
    await deletePage(db, fgaClient, driver, { pageId: page.id, userId: 'dev-user' })
  })

  it('FGA add-NEW failure rolls the DB back to the old space and falls to the invisible side', async () => {
    const page = await createPage(db, fgaClient, driver, { tenantId: tenant.id, spaceId: spaceA, userId: 'dev-user', title: 'x-rollback' })
    await linkToSpace(page.id, spaceA) // published → the swap has an old grant to move
    expect(await check(fgaClient, 'user:dev-user', 'view', { type: 'page', id: page.id })).toBe(true)

    // The add-NEW (space:B grant) write throws; the delete-OLD (space:A) passes.
    await expect(
      movePage(db, fgaFailingAddTo(`space:${spaceB}`), driver, {
        pageId: page.id, userId: 'dev-user', parentId: null, afterId: null, spaceId: spaceB,
      }),
    ).rejects.toThrow()

    // DB rolled back: the page is still in spaceA (no ghost "moved" state).
    expect((await db.sql<{ space_id: string }[]>`SELECT space_id FROM pages WHERE id = ${page.id}`)[0].space_id).toBe(spaceA)
    // Invisible side: OLD grant was deleted, NEW never written → the page has NO
    // space grant, so it is invisible via inheritance from ANY space (NOT visible-
    // from-both). The CREATOR keeps DIRECT access (Phase 4 grant) — a failed move
    // never strands the owner out of their own page; only inheritance was affected.
    expect(await spaceGrantOf(page.id)).toBeNull()
    expect(await check(fgaClient, 'user:dev-user', 'view', { type: 'page', id: page.id })).toBe(true)

    // Repair so the row can be cleaned up through the normal (manage) path.
    await writeTuples(fgaClient, [{ user: `space:${spaceA}`, relation: 'space', object: `page:${page.id}` }])
    await deletePage(db, fgaClient, driver, { pageId: page.id, userId: 'dev-user' })
  })
})

// ── tree listing is FGA-filtered, not just RLS-filtered ────────────────────
//
// the project design notes " OpenFGA ": the page tree must not list (or leak the
// title of) a resource the user cannot view. RLS only enforces tenant isolation.
// Anti-trivial design: the locked space/page are in the SAME tenant (so RLS
// DOES return them) and we assert the user genuinely cannot view them — the only
// thing that excludes them from the listing is the FGA filter under test.

describe('tree listing is FGA-filtered (security)', () => {
  // A space with NO tenant link and NO user grant in FGA. Its DB row is in
  // tenant_dev (RLS returns it) but even the tenant admin cannot view it,
  // because space#viewer derives only from editor/manager/(admin from tenant),
  // and none apply without the tenant link.
  async function seedLocked(label: string): Promise<{ spaceId: string; pageId: string }> {
    const adminPool = postgres(process.env.DATABASE_ADMIN_URL!)
    const [s] = await adminPool<{ id: string }[]>`
      INSERT INTO spaces (tenant_id, name) VALUES (${tenant.id}, ${`locked-${label}`}) RETURNING id`
    const [p] = await adminPool<{ id: string }[]>`
      INSERT INTO pages (tenant_id, space_id, title) VALUES (${tenant.id}, ${s.id}, ${`locked-page-${label}`}) RETURNING id`
    await adminPool.end()
    // Wire only page->space so the model is well-formed; no tenant link, no grant.
    await writeTuples(fgaClient, [{ user: `space:${s.id}`, relation: 'space', object: `page:${p.id}` }])
    return { spaceId: s.id, pageId: p.id }
  }
  async function dropLocked(spaceId: string, pageId: string) {
    await deleteObjectTuples(fgaClient, `page:${pageId}`)
    const ap = postgres(process.env.DATABASE_ADMIN_URL!)
    await ap`DELETE FROM spaces WHERE id = ${spaceId}` // ON DELETE CASCADE removes the page
    await ap.end()
  }

  it('listPages excludes a page the user cannot view, keeps one they can', async () => {
    const space = await createSpace(db, fgaClient, {
      tenantId: tenant.id, userId: 'dev-user', plan: tenant.plan, name: 'tree-fga-pages',
    })
    const visible = await createPage(db, fgaClient, driver, {
      tenantId: tenant.id, spaceId: space.id, userId: 'dev-user', title: 'visible',
    })
    const locked = await seedLocked('pages')

    // Anti-trivial guards: RLS returns the locked page, and the user truly can't view it.
    const rls = await db.sql<{ id: string }[]>`SELECT id FROM pages WHERE id = ${locked.pageId}`
    expect(rls).toHaveLength(1)
    expect(await check(fgaClient, 'user:dev-user', 'view', { type: 'page', id: locked.pageId })).toBe(false)
    expect(await check(fgaClient, 'user:dev-user', 'view', { type: 'page', id: visible.id })).toBe(true)

    expect((await listPages(db, fgaClient, { spaceId: space.id, userId: 'dev-user' })).map((p) => p.id)).toContain(visible.id)
    expect(await listPages(db, fgaClient, { spaceId: locked.spaceId, userId: 'dev-user' })).toHaveLength(0)

    await deletePage(db, fgaClient, driver, { pageId: visible.id, userId: 'dev-user' })
    await deleteSpace(db, fgaClient, driver, { tenantId: tenant.id, spaceId: space.id, userId: 'dev-user' })
    await dropLocked(locked.spaceId, locked.pageId)
  })

  it('listSpaces excludes a space the user cannot view', async () => {
    const locked = await seedLocked('spaces')

    const rls = await db.sql<{ id: string }[]>`SELECT id FROM spaces WHERE id = ${locked.spaceId}`
    expect(rls).toHaveLength(1)
    expect(await check(fgaClient, 'user:dev-user', 'view', { type: 'space', id: locked.spaceId })).toBe(false)

    const spaces = await listSpaces(db, fgaClient, 'dev-user')
    expect(spaces.map((s) => s.id)).not.toContain(locked.spaceId)

    await dropLocked(locked.spaceId, locked.pageId)
  })
})

// ── space-scoped share link (model verification) ───────────────────────────

describe('space-scoped share_link', () => {
  it('grants view on all pages in the space via one tuple, revoke removes all access', async () => {
    const space = await createSpace(db, fgaClient, {
      tenantId: tenant.id, userId: 'dev-user', plan: tenant.plan, name: 'share-link-space-test',
    })
    const page1 = await createPage(db, fgaClient, driver, {
      tenantId: tenant.id, spaceId: space.id, userId: 'dev-user', title: 'P1',
    })
    const page2 = await createPage(db, fgaClient, driver, {
      tenantId: tenant.id, spaceId: space.id, userId: 'dev-user', title: 'P2',
    })
    await linkToSpace(page1.id, space.id); await linkToSpace(page2.id, space.id) // published → space inheritance active

    // Write one space-level share_link tuple (permanent).
    // TODO(phase: guest): issuance API. Direct write here for model verification.
    await writeTuples(fgaClient, [
      { user: 'share_link:space-level-test-link', relation: 'viewer', object: `space:${space.id}` },
    ])

    // Both pages accessible via space inheritance.
    expect(await check(fgaClient, 'share_link:space-level-test-link', 'view', { type: 'page', id: page1.id })).toBe(true)
    expect(await check(fgaClient, 'share_link:space-level-test-link', 'view', { type: 'page', id: page2.id })).toBe(true)

    // Revoke: 1 tuple deletion removes access to all pages in the space.
    await deleteTuples(fgaClient, [
      { user: 'share_link:space-level-test-link', relation: 'viewer', object: `space:${space.id}` },
    ])
    expect(await check(fgaClient, 'share_link:space-level-test-link', 'view', { type: 'page', id: page1.id })).toBe(false)
    expect(await check(fgaClient, 'share_link:space-level-test-link', 'view', { type: 'page', id: page2.id })).toBe(false)

    await deleteSpace(db, fgaClient, driver, { tenantId: tenant.id, spaceId: space.id, userId: 'dev-user' })
  })
})
