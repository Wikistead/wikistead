// Integration tests — real Postgres + real OpenFGA, no mocks.
// Prerequisites: docker compose up -d && pnpm migrate && pnpm fga:bootstrap && pnpm fga:seed
import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { OpenFgaClient } from '@openfga/sdk'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { TenantRegistry } from '../db/registry.js'
import { acquireTenantDb } from '../db/tenant-db.js'
import type { TenantDb } from '../db/index.js'
import { fgaClient, check, writeTuples, deleteTuples } from '@kb/authz'
import { createSpace, listSpaces, deleteSpace } from '../routes/spaces.js'
import { createPage, listPages, getPage, deletePage } from '../routes/pages.js'
import type { Tenant } from '@kb/types'

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
      tenantId: tenant.id, userId: 'dev-user', name: 'test-space',
    })
    expect(space.tenantId).toBe(tenant.id)

    // FGA tuples must exist
    expect(await check(fgaClient, `tenant:${tenant.id}`, 'tenant', { type: 'space', id: space.id })).toBe(true)
    expect(await check(fgaClient, 'user:dev-user', 'manager', { type: 'space', id: space.id })).toBe(true)

    // Cleanup
    await deleteSpace(db, fgaClient, { tenantId: tenant.id, spaceId: space.id, userId: 'dev-user' })
  })

  it('deleteSpace removes DB row and all FGA tuples', async () => {
    const space = await createSpace(db, fgaClient, {
      tenantId: tenant.id, userId: 'dev-user', name: 'delete-me-space',
    })
    const spaceId = space.id
    await deleteSpace(db, fgaClient, { tenantId: tenant.id, spaceId, userId: 'dev-user' })

    const rows = await db.sql`SELECT id FROM spaces WHERE id = ${spaceId}`
    expect(rows).toHaveLength(0)
    expect(await check(fgaClient, 'user:dev-user', 'manager', { type: 'space', id: spaceId })).toBe(false)
  })

  it('FGA write failure rolls back DB INSERT (no ghost space)', async () => {
    const badFga = new OpenFgaClient({
      apiUrl: 'http://127.0.0.1:9999',         // nothing listening
      storeId: '01H5M3YCPQ3ZHWT1J8RYATM4WN',
    })
    const name = `rollback-test-${Date.now()}`
    await expect(
      createSpace(db, badFga, { tenantId: tenant.id, userId: 'dev-user', name }),
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
      tenantId: tenant.id, userId: 'dev-user', name: 'page-test-space',
    })
    spaceId = space.id
  })

  afterAll(async () => {
    await deleteSpace(db, fgaClient, { tenantId: tenant.id, spaceId, userId: 'dev-user' })
  })

  it('createPage writes FGA space tuple and returns the page', async () => {
    const page = await createPage(db, fgaClient, {
      tenantId: tenant.id, spaceId, userId: 'dev-user', title: 'Hello',
    })
    expect(page.spaceId).toBe(spaceId)
    expect(await check(fgaClient, 'user:dev-user', 'view', { type: 'page', id: page.id })).toBe(true)

    await deletePage(db, fgaClient, { pageId: page.id, userId: 'dev-user' })
  })

  it('deletePage removes DB row and FGA tuples including share_link grants', async () => {
    const page = await createPage(db, fgaClient, {
      tenantId: tenant.id, spaceId, userId: 'dev-user', title: 'ToDelete',
    })
    // Simulate a share_link grant on this page
    await writeTuples(fgaClient, [
      { user: 'share_link:page-delete-test-link', relation: 'view', object: `page:${page.id}` },
    ])
    expect(await check(fgaClient, 'share_link:page-delete-test-link', 'view', { type: 'page', id: page.id })).toBe(true)

    await deletePage(db, fgaClient, { pageId: page.id, userId: 'dev-user' })

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
      createPage(db, badFga, { tenantId: tenant.id, spaceId, userId: 'dev-user', title }),
    ).rejects.toThrow()

    const rows = await db.sql<{ id: string }[]>`SELECT id FROM pages WHERE title = ${title}`
    expect(rows).toHaveLength(0)
  })
})

// ── space-scoped share link (model verification) ───────────────────────────

describe('space-scoped share_link', () => {
  it('grants view on all pages in the space via one tuple, revoke removes all access', async () => {
    const space = await createSpace(db, fgaClient, {
      tenantId: tenant.id, userId: 'dev-user', name: 'share-link-space-test',
    })
    const page1 = await createPage(db, fgaClient, {
      tenantId: tenant.id, spaceId: space.id, userId: 'dev-user', title: 'P1',
    })
    const page2 = await createPage(db, fgaClient, {
      tenantId: tenant.id, spaceId: space.id, userId: 'dev-user', title: 'P2',
    })

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

    await deleteSpace(db, fgaClient, { tenantId: tenant.id, spaceId: space.id, userId: 'dev-user' })
  })
})
