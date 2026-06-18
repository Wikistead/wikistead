// Integration tests — real Postgres + real OpenFGA, no mocks.
// Security-critical: this is the anonymous-guest authorization boundary.
import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { pool } from '../db/pool.js'
import { TenantRegistry } from '../db/registry.js'
import { acquireTenantDb } from '../db/tenant-db.js'
import type { TenantDb } from '../db/index.js'
import { fgaClient, check, checkRelation, deleteTuples } from '@wikistead/authz'
import { verifyGuestToken } from '@wikistead/auth'
import { LogicalSearchDriver } from '../search/index.js'
import { createSpace, deleteSpace } from '../routes/spaces.js'
import { createPage } from '../routes/pages.js'
import { createShareLink, listShareLinks, revokeShareLink, mintTokenForShareLink } from '../routes/share-links.js'
import type { Tenant } from '@wikistead/types'

const driver = new LogicalSearchDriver()
const guestCfg = { secret: process.env.GUEST_TOKEN_SECRET!, ttlSeconds: Number(process.env.GUEST_TOKEN_TTL_SECONDS ?? 300) }

let tenant: Tenant
let db: TenantDb
let spaceId: string
let pageId: string

beforeAll(async () => {
  const registry = new TenantRegistry(pool)
  tenant = (await registry.findBySlug('dev'))!
  db = await acquireTenantDb(tenant)
  const space = await createSpace(db, fgaClient, { tenantId: tenant.id, userId: 'dev-user', plan: tenant.plan, name: 'share-test-space' })
  spaceId = space.id
  const page = await createPage(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user', title: 'Shareable' })
  pageId = page.id
})
afterAll(async () => {
  await deleteSpace(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user' })
  await db.release()
  await pool.end()
})

describe('share link lifecycle', () => {
  it('creates a view link, writes the FGA grant, and mints a read-only guest token', async () => {
    const link = await createShareLink(db, fgaClient, {
      tenantId: tenant.id, userId: 'dev-user', resource: { type: 'page', id: pageId }, capability: 'view', expiresInSeconds: null,
    })
    expect(link.capability).toBe('view')
    expect(await checkRelation(fgaClient, `share_link:${link.id}`, 'view', { type: 'page', id: pageId })).toBe(true)

    const minted = await mintTokenForShareLink(fgaClient, tenant.id, link.id)
    expect(minted).not.toBeNull()
    expect(minted!.readOnly).toBe(true)
    expect(minted!.docName).toBe(`t:${tenant.id}:p:${pageId}`)
    const claims = await verifyGuestToken(guestCfg, minted!.token)
    expect(claims.shareLinkId).toBe(link.id)
    expect(claims.capability).toBe('view')
    expect(claims.resource).toEqual({ type: 'page', id: pageId })

    await revokeShareLink(db, fgaClient, { id: link.id, userId: 'dev-user', tenantId: tenant.id })
  })

  it('an edit link mints a non-read-only token', async () => {
    const link = await createShareLink(db, fgaClient, {
      tenantId: tenant.id, userId: 'dev-user', resource: { type: 'page', id: pageId }, capability: 'edit', expiresInSeconds: null,
    })
    const minted = await mintTokenForShareLink(fgaClient, tenant.id, link.id)
    expect(minted!.readOnly).toBe(false)
    expect(minted!.capability).toBe('edit')
    await revokeShareLink(db, fgaClient, { id: link.id, userId: 'dev-user', tenantId: tenant.id })
  })

  it('lists only active links', async () => {
    const a = await createShareLink(db, fgaClient, { tenantId: tenant.id, userId: 'dev-user', resource: { type: 'page', id: pageId }, capability: 'view', expiresInSeconds: null })
    const b = await createShareLink(db, fgaClient, { tenantId: tenant.id, userId: 'dev-user', resource: { type: 'page', id: pageId }, capability: 'edit', expiresInSeconds: null })
    await revokeShareLink(db, fgaClient, { id: b.id, userId: 'dev-user', tenantId: tenant.id })
    const active = await listShareLinks(db, fgaClient, { pageId, userId: 'dev-user' })
    const ids = active.map((l) => l.id)
    expect(ids).toContain(a.id)
    expect(ids).not.toContain(b.id)
    await revokeShareLink(db, fgaClient, { id: a.id, userId: 'dev-user', tenantId: tenant.id })
  })
})

describe('share link security', () => {
  it('revoked link no longer mints a token (tuple deleted = instant)', async () => {
    const link = await createShareLink(db, fgaClient, { tenantId: tenant.id, userId: 'dev-user', resource: { type: 'page', id: pageId }, capability: 'view', expiresInSeconds: null })
    expect(await mintTokenForShareLink(fgaClient, tenant.id, link.id)).not.toBeNull()
    await revokeShareLink(db, fgaClient, { id: link.id, userId: 'dev-user', tenantId: tenant.id })
    expect(await mintTokenForShareLink(fgaClient, tenant.id, link.id)).toBeNull()
  })

  it('unknown / unguessable link id mints nothing (uniform 404, no enumeration)', async () => {
    expect(await mintTokenForShareLink(fgaClient, tenant.id, 'definitely-not-a-real-link-id')).toBeNull()
  })

  it('FGA is the authoritative gate: tuple gone but DB still active -> no token', async () => {
    const link = await createShareLink(db, fgaClient, { tenantId: tenant.id, userId: 'dev-user', resource: { type: 'page', id: pageId }, capability: 'view', expiresInSeconds: null })
    // Simulate DB/FGA divergence: delete the grant WITHOUT stamping revoked_at.
    await deleteTuples(fgaClient, [{ user: `share_link:${link.id}`, relation: 'view', object: `page:${pageId}` }])
    const [row] = await db.sql<{ revoked_at: Date | null }[]>`SELECT revoked_at FROM share_links WHERE id = ${link.id}`
    expect(row.revoked_at).toBeNull() // DB still thinks it is active (anti-trivial)
    // ...yet the FGA gate refuses to mint.
    expect(await mintTokenForShareLink(fgaClient, tenant.id, link.id)).toBeNull()
    await revokeShareLink(db, fgaClient, { id: link.id, userId: 'dev-user', tenantId: tenant.id })
  })

  it('expired link mints nothing; an unexpired one works', async () => {
    const link = await createShareLink(db, fgaClient, { tenantId: tenant.id, userId: 'dev-user', resource: { type: 'page', id: pageId }, capability: 'view', expiresInSeconds: 1 })
    expect(await mintTokenForShareLink(fgaClient, tenant.id, link.id)).not.toBeNull() // still within 1s
    await new Promise((r) => setTimeout(r, 1200))
    expect(await mintTokenForShareLink(fgaClient, tenant.id, link.id)).toBeNull() // expired
    await revokeShareLink(db, fgaClient, { id: link.id, userId: 'dev-user', tenantId: tenant.id })
  })

  it('a user without manage cannot create a link', async () => {
    await expect(
      createShareLink(db, fgaClient, { tenantId: tenant.id, userId: 'stranger', resource: { type: 'page', id: pageId }, capability: 'view', expiresInSeconds: null }),
    ).rejects.toThrow()
  })

  it('cross-tenant: minting under another tenant cannot see the link', async () => {
    const link = await createShareLink(db, fgaClient, { tenantId: tenant.id, userId: 'dev-user', resource: { type: 'page', id: pageId }, capability: 'view', expiresInSeconds: null })
    // tenant_acme RLS context cannot read a tenant_dev share_link row -> null.
    expect(await mintTokenForShareLink(fgaClient, 'tenant_acme', link.id)).toBeNull()
    await revokeShareLink(db, fgaClient, { id: link.id, userId: 'dev-user', tenantId: tenant.id })
  })
})
