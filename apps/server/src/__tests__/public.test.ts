// Integration tests — real Postgres + real OpenFGA, no mocks.
// Prerequisites: docker compose up -d && pnpm migrate && pnpm fga:bootstrap && pnpm fga:seed
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as Y from 'yjs'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { TenantRegistry } from '../db/registry.js'
import { acquireTenantDb } from '../db/tenant-db.js'
import type { TenantDb } from '../db/index.js'
import { fgaClient, writeTuples, deleteTuples } from '@kb/authz'
import { LogicalSearchDriver } from '../search/index.js'
import { createSpace, deleteSpace } from '../routes/spaces.js'
import { createPage, deletePage } from '../routes/pages.js'
import { checkRelation } from '@kb/authz'
import type { Tenant } from '@kb/types'

// The anonymous principal used for all public checks.
// user:anonymous has NO relationships — can only access pages via user:* wildcard.
const ANON = 'user:anonymous'

const driver = new LogicalSearchDriver()
const adminPool = postgres(process.env.DATABASE_ADMIN_URL!)

let tenant: Tenant
let db: TenantDb
let spaceId: string
let publicPageId: string
let privatePageId: string

// Seed a ydoc with known content for the public page
function makeYdoc(text: string): Buffer {
  const doc = new Y.Doc()
  doc.getText('content').insert(0, text)
  return Buffer.from(Y.encodeStateAsUpdate(doc))
}

beforeAll(async () => {
  const registry = new TenantRegistry(pool)
  tenant = (await registry.findBySlug('dev'))!
  db = await acquireTenantDb(tenant)

  const space = await createSpace(db, fgaClient, {
    tenantId: tenant.id, userId: 'dev-user', plan: tenant.plan, name: 'public-test-space',
  })
  spaceId = space.id

  // Public page: will have page:X#view@user:* tuple
  const pub = await createPage(db, fgaClient, driver, {
    tenantId: tenant.id, spaceId, userId: 'dev-user', title: 'Public Page',
  })
  publicPageId = pub.id
  await adminPool`UPDATE pages SET ydoc = ${makeYdoc('hello public world')} WHERE id = ${publicPageId}`

  // Write the public tuple
  await writeTuples(fgaClient, [
    { user: 'user:*', relation: 'view', object: `page:${publicPageId}` },
  ])

  // Private page: no user:* tuple
  const priv = await createPage(db, fgaClient, driver, {
    tenantId: tenant.id, spaceId, userId: 'dev-user', title: 'Private Page',
  })
  privatePageId = priv.id
})

afterAll(async () => {
  await deleteTuples(fgaClient, [{ user: 'user:*', relation: 'view', object: `page:${publicPageId}` }])
  await deletePage(db, fgaClient, driver, { pageId: publicPageId, userId: 'dev-user' })
  await deletePage(db, fgaClient, driver, { pageId: privatePageId, userId: 'dev-user' })
  await deleteSpace(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user' })
  await db.release()
  await pool.end()
  await adminPool.end()
})

// ── user:anonymous principal ──────────────────────────────────────────────

describe('user:anonymous principal semantics', () => {
  it('user:anonymous can view a page with user:* grant (via FGA check)', async () => {
    const ok = await checkRelation(fgaClient, ANON, 'view', { type: 'page', id: publicPageId })
    expect(ok).toBe(true)
  })

  it('user:anonymous cannot view a private page (no user:* grant)', async () => {
    const ok = await checkRelation(fgaClient, ANON, 'view', { type: 'page', id: privatePageId })
    expect(ok).toBe(false)
  })

  it('user:anonymous cannot view private page even after deleting public grant (revocation)', async () => {
    // Write, verify true, delete, verify false
    const pageId = publicPageId  // already has grant; test deletion
    await deleteTuples(fgaClient, [{ user: 'user:*', relation: 'view', object: `page:${pageId}` }])
    expect(await checkRelation(fgaClient, ANON, 'view', { type: 'page', id: pageId })).toBe(false)

    // Restore for subsequent tests
    await writeTuples(fgaClient, [{ user: 'user:*', relation: 'view', object: `page:${pageId}` }])
    expect(await checkRelation(fgaClient, ANON, 'view', { type: 'page', id: pageId })).toBe(true)
  })
})

// ── loadPublicPage (service-level test via DB) ────────────────────────────

describe('public page rendering', () => {
  it('returns correct content for a public page', async () => {
    const isPublic = await checkRelation(fgaClient, ANON, 'view', { type: 'page', id: publicPageId })
    expect(isPublic).toBe(true)

    // Read page under RLS (tenant_dev context)
    const page = await pool.begin(async (tx) => {
      await tx`SELECT set_config('app.tenant_id', ${tenant.id}, true)`
      const [r] = await tx<{ id: string; title: string; ydoc: Buffer | null; noindex: boolean }[]>`
        SELECT id, title, ydoc, noindex FROM pages WHERE id = ${publicPageId}
      `
      return r ?? null
    }) as { id: string; title: string; ydoc: Buffer | null; noindex: boolean } | null

    expect(page).not.toBeNull()
    expect(page!.title).toBe('Public Page')
    expect(page!.noindex).toBe(false)

    // Decode Y.Text content
    const doc = new Y.Doc()
    Y.applyUpdate(doc, new Uint8Array(page!.ydoc!))
    expect(doc.getText('content').toString()).toBe('hello public world')
  })

  it('private page check returns false (not 403, no info leakage about existence)', async () => {
    const isPublic = await checkRelation(fgaClient, ANON, 'view', { type: 'page', id: privatePageId })
    expect(isPublic).toBe(false)
    // Caller should return 404, not 403, to avoid leaking that the page exists
  })

  it('tenant RLS is active even for public pages (cross-tenant page returns null)', async () => {
    // Insert an acme page with a public tuple
    const [{ id: acmeSpaceId }] = await adminPool<[{ id: string }]>`
      INSERT INTO spaces (tenant_id, name) VALUES ('tenant_acme', 'public-test-acme-space') RETURNING id
    `
    const [{ id: acmePageId }] = await adminPool<[{ id: string }]>`
      INSERT INTO pages (tenant_id, space_id, title)
      VALUES ('tenant_acme', ${acmeSpaceId}, 'Acme Public Page') RETURNING id
    `
    await writeTuples(fgaClient, [{ user: 'user:*', relation: 'view', object: `page:${acmePageId}` }])

    try {
      // FGA says the acme page is public (user:anonymous can view it)
      expect(await checkRelation(fgaClient, ANON, 'view', { type: 'page', id: acmePageId })).toBe(true)

      // But reading it under tenant_dev RLS returns null (tenant isolation holds)
      const row = await pool.begin(async (tx) => {
        await tx`SELECT set_config('app.tenant_id', ${tenant.id}, true)`
        const [r] = await tx`SELECT id FROM pages WHERE id = ${acmePageId}`
        return r ?? null
      }) as unknown as null

      expect(row).toBeNull()
    } finally {
      await deleteTuples(fgaClient, [{ user: 'user:*', relation: 'view', object: `page:${acmePageId}` }])
      await adminPool`DELETE FROM spaces WHERE id = ${acmeSpaceId}`
    }
  })
})

// ── listObjects with user:anonymous ──────────────────────────────────────

describe('listObjects for public pages', () => {
  it('lists public pages via user:anonymous (consistent with single check)', async () => {
    const { objects } = await fgaClient.listObjects({
      user: ANON,
      relation: 'view',
      type: 'page',
    })
    const ids = (objects ?? []).map((o: string) => o.replace(/^page:/, ''))
    expect(ids).toContain(publicPageId)
    expect(ids).not.toContain(privatePageId)
  })
})

// ── noindex field ─────────────────────────────────────────────────────────

describe('noindex', () => {
  it('noindex defaults to false', async () => {
    const [row] = await adminPool<[{ noindex: boolean }]>`SELECT noindex FROM pages WHERE id = ${publicPageId}`
    expect(row.noindex).toBe(false)
  })

  it('noindex=true is reflected in the page response', async () => {
    await adminPool`UPDATE pages SET noindex = true WHERE id = ${publicPageId}`
    const [row] = await adminPool<[{ noindex: boolean }]>`SELECT noindex FROM pages WHERE id = ${publicPageId}`
    expect(row.noindex).toBe(true)
    // noindex enforcement (X-Robots-Tag, <meta>) is the HTML rendering layer's
    // responsibility — tested here only as field presence.
    await adminPool`UPDATE pages SET noindex = false WHERE id = ${publicPageId}`
  })
})
