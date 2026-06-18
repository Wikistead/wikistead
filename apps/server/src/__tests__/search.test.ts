// Integration tests — real Postgres + real OpenFGA + real Meilisearch, no mocks.
// Prerequisites: docker compose up -d (postgres, openfga, meilisearch)
//                pnpm migrate && pnpm fga:bootstrap && pnpm fga:seed
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { pool } from '../db/pool.js'
import { TenantRegistry } from '../db/registry.js'
import { acquireTenantDb } from '../db/tenant-db.js'
import type { TenantDb } from '../db/index.js'
import { fgaClient, writeTuples, deleteTuples } from '@kb/authz'
import { LogicalSearchDriver, buildSearchDoc } from '../search/index.js'
import { createSpace, deleteSpace } from '../routes/spaces.js'
import { createPage, updatePage, deletePage } from '../routes/pages.js'
import type { Tenant } from '@kb/types'

const driver = new LogicalSearchDriver()
let tenant: Tenant
let db: TenantDb
let spaceId: string
const createdPageIds: string[] = []

beforeAll(async () => {
  await driver.ensureIndex()
  const registry = new TenantRegistry(pool)
  tenant = (await registry.findBySlug('dev'))!
  db = await acquireTenantDb(tenant)
  const space = await createSpace(db, fgaClient, {
    tenantId: tenant.id, userId: 'dev-user', plan: tenant.plan, name: 'search-test-space',
  })
  spaceId = space.id
})

afterAll(async () => {
  for (const id of createdPageIds) {
    try { await deletePage(db, fgaClient, driver, { pageId: id, userId: 'dev-user' }) } catch {}
  }
  await deleteSpace(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user' })
  await db.release()
  await pool.end()
})

// Wait for fire-and-forget outbox processing to reach Meilisearch.
// upsertDoc/deleteDoc await Meili task completion, so the main cost is
// 3× FGA reads in buildSearchDoc + the Meili task itself (usually < 500ms).
function wait(ms = 1500): Promise<void> { return new Promise(r => setTimeout(r, ms)) }

// ── buildSearchDoc ────────────────────────────────────────────────────────

describe('buildSearchDoc', () => {
  it('returns a document with correct viewer set for a page', async () => {
    const page = await createPage(db, fgaClient, driver, {
      tenantId: tenant.id, spaceId, userId: 'dev-user', title: 'doc-builder-test',
    })
    createdPageIds.push(page.id)

    const doc = await buildSearchDoc(pool, fgaClient, page.id, tenant.id)
    expect(doc).not.toBeNull()
    expect(doc!.title).toBe('doc-builder-test')
    expect(doc!.viewerUsers).toContain('user:dev-user')
    expect(doc!.isPublic).toBe(false)
    expect(doc!.body).toBe('')  // title-only phase; body populated in collab phase
  })

  it('returns null for a non-existent page', async () => {
    const doc = await buildSearchDoc(pool, fgaClient, 'page:nonexistent-xyz', tenant.id)
    expect(doc).toBeNull()
  })
})

// ── Indexing (upsert / delete) ────────────────────────────────────────────

describe('search indexing', () => {
  it('createPage triggers upsert: page appears in search results', async () => {
    const page = await createPage(db, fgaClient, driver, {
      tenantId: tenant.id, spaceId, userId: 'dev-user', title: 'indexing-test-unique-abc123',
    })
    createdPageIds.push(page.id)
    await wait()  // allow fire-and-forget outbox to process

    const hits = await driver.search({
      tenantId: tenant.id, userId: 'dev-user', groups: [],
      q: 'indexing-test-unique-abc123',
    })
    expect(hits.some(h => h.id === page.id)).toBe(true)
  })

  it('updatePage triggers upsert: updated title appears in search', async () => {
    const page = await createPage(db, fgaClient, driver, {
      tenantId: tenant.id, spaceId, userId: 'dev-user', title: 'before-update',
    })
    createdPageIds.push(page.id)
    await updatePage(db, fgaClient, driver, { pageId: page.id, userId: 'dev-user', title: 'after-update-unique-xyz789' })
    await wait()

    const hits = await driver.search({
      tenantId: tenant.id, userId: 'dev-user', groups: [],
      q: 'after-update-unique-xyz789',
    })
    expect(hits.some(h => h.id === page.id)).toBe(true)
  })

  it('deletePage triggers delete: page disappears from search', async () => {
    const page = await createPage(db, fgaClient, driver, {
      tenantId: tenant.id, spaceId, userId: 'dev-user', title: 'to-be-deleted-unique-mno456',
    })
    await wait()
    await deletePage(db, fgaClient, driver, { pageId: page.id, userId: 'dev-user' })
    await wait()

    const hits = await driver.search({
      tenantId: tenant.id, userId: 'dev-user', groups: [],
      q: 'to-be-deleted-unique-mno456',
    })
    expect(hits.some(h => h.id === page.id)).toBe(false)
  })
})

// ── Two-stage guard ───────────────────────────────────────────────────────

describe('two-stage guard', () => {
  it('Stage 2 FGA check removes stale Meili result that failed permission', async () => {
    // Directly upsert a doc to Meili with viewer_users including 'user:eve',
    // bypassing the normal create flow (simulates stale/corrupted Meili state).
    // OpenFGA does NOT have a corresponding view grant for user:eve.
    await driver.upsertDoc({
      id: 'stale-test-doc-99', tenantId: tenant.id, spaceId, title: 'stale-doc',
      body: '', viewerUsers: ['user:eve'], viewerGroups: [], isPublic: false, updatedAt: Date.now(),
    })
    await wait()

    // Stage 1 (Meili): would return this doc for user:eve
    const stage1 = await driver.search({ tenantId: tenant.id, userId: 'eve', groups: [], q: 'stale-doc' })
    expect(stage1.some(h => h.id === 'stale-test-doc-99')).toBe(true)

    // Stage 2 (FGA): filters it out (no tuple for user:eve on stale-test-doc-99)
    const { filterAuthorized } = await import('@kb/authz')
    const authorized = await filterAuthorized(fgaClient, 'user:eve', 'view', stage1.map(h => h.id))
    expect(authorized.has('stale-test-doc-99')).toBe(false)

    // Cleanup: remove the stale doc
    await driver.deleteDoc('stale-test-doc-99')
  })
})

// ── Permission revocation → Meili sync ───────────────────────────────────

describe('permission revocation', () => {
  it('removing space viewer updates Meili doc to exclude that user', async () => {
    // Grant 'user:revoke-test' viewer on the space directly
    await writeTuples(fgaClient, [
      { user: 'user:revoke-test', relation: 'viewer', object: `space:${spaceId}` },
    ])
    const page = await createPage(db, fgaClient, driver, {
      tenantId: tenant.id, spaceId, userId: 'dev-user', title: 'revoke-viewer-test',
    })
    createdPageIds.push(page.id)
    await wait()

    // Before revocation: user:revoke-test appears in viewerUsers
    const docBefore = await buildSearchDoc(pool, fgaClient, page.id, tenant.id)
    expect(docBefore!.viewerUsers).toContain('user:revoke-test')

    // Revoke: delete the space viewer tuple
    await deleteTuples(fgaClient, [
      { user: 'user:revoke-test', relation: 'viewer', object: `space:${spaceId}` },
    ])

    // Rebuild search doc (simulates outbox-triggered reindex after revocation)
    const docAfter = await buildSearchDoc(pool, fgaClient, page.id, tenant.id)
    expect(docAfter!.viewerUsers).not.toContain('user:revoke-test')

    // Upsert the updated doc to Meili (outbox processing would do this)
    await driver.upsertDoc(docAfter!)
    await wait()

    // Verify Meili no longer returns the page for user:revoke-test
    const hits = await driver.search({
      tenantId: tenant.id, userId: 'revoke-test', groups: [],
      q: 'revoke-viewer-test',
    })
    expect(hits.some(h => h.id === page.id)).toBe(false)
  })
})

// ── Tenant isolation ──────────────────────────────────────────────────────

describe('tenant isolation in search', () => {
  it('search results do not bleed across tenants', async () => {
    // Directly insert a stale Meili doc with acme's tenant_id
    await driver.upsertDoc({
      id: 'page:acme-leak-test', tenantId: 'tenant_acme', spaceId: 'space:acme_space',
      title: 'acme-cross-tenant-leak', body: '',
      viewerUsers: ['user:dev-user'], viewerGroups: [], isPublic: true, updatedAt: Date.now(),
    })
    await wait()

    // dev-user searches within tenant_dev — must not see tenant_acme docs
    const hits = await driver.search({
      tenantId: tenant.id, userId: 'dev-user', groups: [],
      q: 'acme-cross-tenant-leak',
    })
    expect(hits.some(h => h.id === 'page:acme-leak-test')).toBe(false)

    await driver.deleteDoc('page:acme-leak-test')
  })
})
