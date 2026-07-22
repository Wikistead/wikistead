// #486 / ADR-150 Addendum 2 (slice 3): the revision-history list resolves author display names
// server-side on this VIEW-GATED (member-only history) response. Real Postgres + FGA. Anti-tests:
// a member author resolves (override ?? OIDC) — note a revision's created_by is the `user:<sub>` FGA
// principal form, so the prefix is stripped before the members lookup; a CROSS-TENANT author → null
// (RLS absent); a GUEST author → null; no email / cross-tenant name in the payload.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { TenantRegistry } from '../db/registry.js'
import { acquireTenantDb } from '../db/tenant-db.js'
import type { TenantDb } from '../db/index.js'
import { fgaClient } from '@wikistead/authz'
import { LogicalSearchDriver } from '../search/index.js'
import { createSpace, deleteSpace } from '../routes/spaces.js'
import { createPage, deletePage } from '../routes/pages.js'
import { listRevisions } from '../routes/revisions.js'
import type { Tenant } from '@wikistead/types'

const driver = new LogicalSearchDriver()
const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const TENANT = 'tenant_dev'
const OTHER = 'tenant_acme'
const MEMBER = 'rev486-member'
const FOREIGN = 'rev486-foreign'

let tenant: Tenant
let db: TenantDb
let spaceId: string
let pageId: string

beforeAll(async () => {
  tenant = (await new TenantRegistry(pool).findBySlug('dev'))!
  db = await acquireTenantDb(tenant)
  const space = await createSpace(db, fgaClient, { tenantId: tenant.id, userId: 'dev-user', plan: tenant.plan, name: 'rev486-space' })
  spaceId = space.id
  const p = await createPage(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user', title: 'rev486' })
  pageId = p.id
  await admin`INSERT INTO members (tenant_id, sub, email, role, display_name, display_name_override, avatar_image_key) VALUES
    (${TENANT}, ${MEMBER}, ${MEMBER + '@e2e.test'}, 'member', 'IdP R', 'Member 486r', 'avatars/r.png'),
    (${OTHER}, ${FOREIGN}, ${FOREIGN + '@e2e.test'}, 'member', 'Foreign IdP', 'Foreign 486r', NULL)
    ON CONFLICT DO NOTHING`
  // Revisions store created_by as the FGA-principal form `user:<sub>` (or guest:/anon:).
  await admin`INSERT INTO revisions (tenant_id, page_id, ydoc_key, title, created_by) VALUES
    (${TENANT}, ${pageId}, 'rev486-k1', 'by member',  ${'user:' + MEMBER}),
    (${TENANT}, ${pageId}, 'rev486-k2', 'by foreign', ${'user:' + FOREIGN}),
    (${TENANT}, ${pageId}, 'rev486-k3', 'by guest',   'guest:abc-123')`
}, 40_000)

afterAll(async () => {
  await deletePage(db, fgaClient, driver, { pageId, userId: 'dev-user' }).catch(() => {}) // cascades revisions
  await deleteSpace(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user' }).catch(() => {})
  await admin`DELETE FROM members WHERE sub LIKE 'rev486-%'`.catch(() => {})
  await db.release()
  await pool.end().catch(() => {})
  await admin.end().catch(() => {})
}, 40_000)

describe('listRevisions author identity (#486 slice 3)', () => {
  it('resolves member author names (stripping user:); cross-tenant & guest are null', async () => {
    const revs = await listRevisions(db, fgaClient, { pageId, userId: 'dev-user', plan: tenant.plan })
    const byTitle = (t: string) => revs.find((r) => r.title === t)!
    expect(byTitle('by member').createdByName).toBe('Member 486r')
    expect(byTitle('by member').createdByHasAvatar).toBe(true)
    expect(byTitle('by foreign').createdByName).toBeNull() // cross-tenant → RLS absent
    expect(byTitle('by guest').createdByName).toBeNull()   // guest sub dropped
    const json = JSON.stringify(revs)
    expect(json).not.toContain('@e2e.test')
    expect(json).not.toContain('Foreign')
  })
})
