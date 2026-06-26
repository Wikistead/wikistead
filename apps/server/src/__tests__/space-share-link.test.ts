// #104 / ADR-038: space-scoped share links. Issuance (space manage-gated, view-only) + the
// DSL anti-tests on the (pre-existing) space#viewer@share_link grant. Real Postgres + OpenFGA.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import type { Tenant } from '@wikistead/types'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { fgaClient, checkRelation, deleteTuples } from '@wikistead/authz'
import { LogicalSearchDriver } from '../search/index.js'
import { provisionTenant } from '../auth/provisioning.js'
import { createSpace, deleteSpace } from '../routes/spaces.js'
import { createPage, publishPage } from '../routes/pages.js'
import { createShareLink, revokeShareLink } from '../routes/share-links.js'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const driver = new LogicalSearchDriver()
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'free', isolation: 'logical' }) as Tenant
const OWNER = 'spacelink-owner'

let tenantId: string
let db: TenantDb
let spaceA: string
let spaceB: string
let pageA1: string
let pageA2: string
let pageB1: string

const canView = (linkId: string, pageId: string) =>
  checkRelation(fgaClient, `share_link:${linkId}`, 'view', { type: 'page', id: pageId })

beforeAll(async () => {
  ;({ tenantId } = await provisionTenant(fgaClient, { slug: `spacelink-${Date.now().toString(36)}`, admin: { sub: OWNER } }))
  db = await acquireTenantDb(asTenant(tenantId))
  spaceA = (await createSpace(db, fgaClient, { tenantId, userId: OWNER, plan: 'free', name: 'A' })).id
  spaceB = (await createSpace(db, fgaClient, { tenantId, userId: OWNER, plan: 'free', name: 'B' })).id
  pageA1 = (await createPage(db, fgaClient, driver, { tenantId, spaceId: spaceA, userId: OWNER, title: 'A1' })).id
  pageA2 = (await createPage(db, fgaClient, driver, { tenantId, spaceId: spaceA, userId: OWNER, title: 'A2' })).id
  pageB1 = (await createPage(db, fgaClient, driver, { tenantId, spaceId: spaceB, userId: OWNER, title: 'B1' })).id
  // A space link exposes PUBLISHED pages (publish writes page#space, enabling `viewer from
  // space` inheritance). Drafts stay creator-only — they are not shared by a space link.
  for (const id of [pageA1, pageA2, pageB1]) {
    await publishPage(db, fgaClient, driver, { pageId: id, subject: `user:${OWNER}`, createdBy: `user:${OWNER}` })
  }
})

afterAll(async () => {
  await deleteSpace(db, fgaClient, driver, { tenantId, spaceId: spaceA, userId: OWNER }).catch(() => {})
  await deleteSpace(db, fgaClient, driver, { tenantId, spaceId: spaceB, userId: OWNER }).catch(() => {})
  await admin`DELETE FROM share_links WHERE tenant_id = ${tenantId}`.catch(() => {})
  await admin`DELETE FROM members WHERE tenant_id = ${tenantId}`.catch(() => {})
  await admin`DELETE FROM tenants WHERE id = ${tenantId}`.catch(() => {})
  await db.release()
  await admin.end()
  await pool.end()
})

describe('#104 space share-link issuance', () => {
  it('space manage holder can mint a view link; it grants view across the WHOLE space (①)', async () => {
    const link = await createShareLink(db, fgaClient, { tenantId, plan: 'free', userId: OWNER, resource: { type: 'space', id: spaceA }, capability: 'view', expiresInSeconds: null })
    expect(link.resource).toEqual({ type: 'space', id: spaceA })
    expect(await canView(link.id, pageA1)).toBe(true) // every page in A
    expect(await canView(link.id, pageA2)).toBe(true)
    await revokeShareLink(db, fgaClient, { id: link.id, userId: OWNER, tenantId })
  })

  it('does NOT leak to pages in another space (② no cross-space)', async () => {
    const link = await createShareLink(db, fgaClient, { tenantId, plan: 'free', userId: OWNER, resource: { type: 'space', id: spaceA }, capability: 'view', expiresInSeconds: null })
    expect(await canView(link.id, pageB1)).toBe(false) // B1 is in space B
    await revokeShareLink(db, fgaClient, { id: link.id, userId: OWNER, tenantId })
  })

  it('does not interfere with a page-scoped share link (③ independent tuples)', async () => {
    const spaceLink = await createShareLink(db, fgaClient, { tenantId, plan: 'free', userId: OWNER, resource: { type: 'space', id: spaceA }, capability: 'view', expiresInSeconds: null })
    const pageLink = await createShareLink(db, fgaClient, { tenantId, plan: 'free', userId: OWNER, resource: { type: 'page', id: pageB1 }, capability: 'view', expiresInSeconds: null })
    // each link sees only its own resource
    expect(await canView(spaceLink.id, pageA1)).toBe(true)
    expect(await canView(spaceLink.id, pageB1)).toBe(false)
    expect(await canView(pageLink.id, pageB1)).toBe(true)
    expect(await canView(pageLink.id, pageA1)).toBe(false)
    // revoking the page link leaves the space link intact
    await revokeShareLink(db, fgaClient, { id: pageLink.id, userId: OWNER, tenantId })
    expect(await canView(spaceLink.id, pageA1)).toBe(true)
    await revokeShareLink(db, fgaClient, { id: spaceLink.id, userId: OWNER, tenantId })
  })

  it('revoke cuts view for ALL pages in the space in one op; another link on the space survives (④)', async () => {
    const link1 = await createShareLink(db, fgaClient, { tenantId, plan: 'free', userId: OWNER, resource: { type: 'space', id: spaceA }, capability: 'view', expiresInSeconds: null })
    const link2 = await createShareLink(db, fgaClient, { tenantId, plan: 'free', userId: OWNER, resource: { type: 'space', id: spaceA }, capability: 'view', expiresInSeconds: null })
    await revokeShareLink(db, fgaClient, { id: link1.id, userId: OWNER, tenantId }) // one tuple delete
    expect(await canView(link1.id, pageA1)).toBe(false)
    expect(await canView(link1.id, pageA2)).toBe(false) // all of A's pages cut at once
    expect(await canView(link2.id, pageA1)).toBe(true) // the other space link is independent
    await revokeShareLink(db, fgaClient, { id: link2.id, userId: OWNER, tenantId })
  })

  it('rejects an EDIT space link (space links are view-only)', async () => {
    await expect(
      createShareLink(db, fgaClient, { tenantId, plan: 'free', userId: OWNER, resource: { type: 'space', id: spaceA }, capability: 'edit', expiresInSeconds: null }),
    ).rejects.toMatchObject({ statusCode: 400 })
  })

  it('requires space manage (a non-manager is 403)', async () => {
    await expect(
      createShareLink(db, fgaClient, { tenantId, plan: 'free', userId: 'spacelink-stranger', resource: { type: 'space', id: spaceA }, capability: 'view', expiresInSeconds: null }),
    ).rejects.toMatchObject({ statusCode: 403 })
  })
})
