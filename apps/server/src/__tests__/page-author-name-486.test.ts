// #486 / ADR-150 Addendum 2: the page-meta author name is resolved server-side on the VIEW-GATED getPage
// response. Real Postgres + FGA. Anti-tests (the reviewer's R3/R4 invariants):
//  - FULL resolution (override ?? OIDC name), UNLIKE the customized-only /members/identities resolver — a
//    member who never customized still resolves on this gated surface;
//  - NEVER an email / local-part; a member with no name → null;
//  - a CROSS-TENANT author → null (resolved on the caller's RLS handle → absent — no cross-tenant leak);
//  - guest/anon author subs are dropped.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { TenantRegistry } from '../db/registry.js'
import { acquireTenantDb } from '../db/tenant-db.js'
import type { TenantDb } from '../db/index.js'
import { fgaClient } from '@wikistead/authz'
import { LogicalSearchDriver } from '../search/index.js'
import { createSpace, deleteSpace } from '../routes/spaces.js'
import { createPage, deletePage, getPage } from '../routes/pages.js'
import type { Tenant } from '@wikistead/types'

const driver = new LogicalSearchDriver()
const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const OTHER = 'tenant_acme'

const NAMED = 'auth486-named'      // override set → the chosen name wins; also has an avatar
const PLAIN = 'auth486-plain'      // OIDC display_name only, NO override/avatar → resolves to the IdP name
const EMPTY = 'auth486-empty'      // member, NO display_name/override → null (NEVER the email)
const FOREIGN = 'auth486-foreign'  // member of ANOTHER tenant (customized there) → null here (RLS absent)

let tenant: Tenant
let db: TenantDb
let spaceId: string
let pageId: string

beforeAll(async () => {
  tenant = (await new TenantRegistry(pool).findBySlug('dev'))!
  db = await acquireTenantDb(tenant)
  const space = await createSpace(db, fgaClient, { tenantId: tenant.id, userId: 'dev-user', plan: tenant.plan, name: 'auth486-space' })
  spaceId = space.id
  const p = await createPage(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user', title: 'auth486' })
  pageId = p.id
  await admin`INSERT INTO members (tenant_id, sub, email, role, display_name, display_name_override, avatar_image_key) VALUES
    (${tenant.id}, ${NAMED}, ${NAMED + '@e2e.test'}, 'member', 'IdP 486', 'Chosen 486', 'avatars/486.png'),
    (${tenant.id}, ${PLAIN}, ${PLAIN + '@e2e.test'}, 'member', 'Plain 486', NULL, NULL),
    (${tenant.id}, ${EMPTY}, ${EMPTY + '@e2e.test'}, 'member', NULL, NULL, NULL),
    (${OTHER}, ${FOREIGN}, ${FOREIGN + '@e2e.test'}, 'member', 'Foreign IdP', 'Foreign Chosen', NULL)
    ON CONFLICT DO NOTHING`
}, 30_000)

afterAll(async () => {
  await deletePage(db, fgaClient, driver, { pageId, userId: 'dev-user' }).catch(() => {})
  await deleteSpace(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user' }).catch(() => {})
  await admin`DELETE FROM members WHERE sub LIKE 'auth486-%'`.catch(() => {})
  await db.release() // release the checked-out tenant connection BEFORE pool.end() (else it waits forever)
  await pool.end().catch(() => {})
  await admin.end().catch(() => {})
}, 60_000)

async function metaWith(createdBy: string | null, updatedBy: string | null) {
  await admin`UPDATE pages SET created_by = ${createdBy}, updated_by = ${updatedBy} WHERE id = ${pageId}`
  return getPage(db, fgaClient, { pageId, userId: 'dev-user' })
}

describe('getPage author identity (#486 / ADR-150 Addendum 2)', () => {
  it('resolves the FULL name (override ?? OIDC) on the gated response — including un-customized members', async () => {
    const p = await metaWith(NAMED, PLAIN)
    expect(p.createdByName).toBe('Chosen 486') // override wins
    expect(p.createdByHasAvatar).toBe(true)
    // the KEY difference from the customized-only resolver: a member who never customized still resolves
    // to their IdP display name on a view-gated surface (the surface already reveals authorship).
    expect(p.updatedByName).toBe('Plain 486')
    expect(p.updatedByHasAvatar).toBe(false)
  })

  it('never falls back to an email / local-part; a member with no name is null', async () => {
    const p = await metaWith(EMPTY, EMPTY)
    expect(p.createdByName).toBeNull()
    expect(p.createdByHasAvatar).toBe(false)
    expect(JSON.stringify(p)).not.toContain('@e2e.test') // the email never leaks in any field
  })

  it('a cross-tenant author resolves to null (RLS absent — no cross-tenant name leak)', async () => {
    const p = await metaWith(FOREIGN, FOREIGN)
    expect(p.createdByName).toBeNull()
    expect(p.createdByHasAvatar).toBe(false)
    expect(JSON.stringify(p)).not.toContain('Foreign') // neither the IdP name nor the override crosses the tenant
  })

  it('a guest/anon author sub is dropped (never a member query, no name)', async () => {
    const p = await metaWith('guest:abc-123', 'anon:7f3a1b2c3d4e')
    expect(p.createdByName).toBeNull()
    expect(p.updatedByName).toBeNull()
  })
})
