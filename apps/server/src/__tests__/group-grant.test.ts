// Integration test — real Postgres + OpenFGA, no mocks. #163 / ADR-053: grant a page/space to a
// group BY NAME. Security-critical (authz boundary): the grant must resolve to the SAME FGA id the
// #111 membership sync wrote (so a synced member gains access and a non-member does not), the group
// source must be manage-gated (group names can leak existence) and tenant-scoped, and the
// server — not the client — must be the id authority.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { fgaClient, checkRelation } from '@wikistead/authz'
import { buildApp } from '../app.js'
import { createSpace } from '../routes/spaces.js'
import { createPage } from '../routes/pages.js'
import { grantSpaceAccess, revokeSpaceAccess, listTenantGroups, listSpaceAccess } from '../routes/spaces.js'
import { grantPageAccess } from '../routes/pages.js'
import { groupFgaId, groupGrantee, syncMemberGroups } from '../auth/group-sync.js'
import type { FastifyInstance } from 'fastify'
import type { Tenant } from '@wikistead/types'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const T = 'tenant_dev'
const MANAGER = 'dev-user' // tenant_dev admin (seed) → space manager via inheritance
const MEMBER = 'grant-grp-member' // synced into "Engineering"
const STRANGER = 'grant-grp-stranger' // in no group
const GROUP = 'Engineering'
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'free', isolation: 'logical' }) as Tenant

let app: FastifyInstance
let db: TenantDb
let spaceId: string
let pageId: string

const cleanupFga = async () => {
  // Delete each group#member individually (deleteTuples isn't idempotent) so a prior run's
  // leftover can't make the fresh sync write a duplicate.
  const { deleteTuples } = await import('@wikistead/authz')
  for (const g of ['Engineering', 'Sales']) {
    await deleteTuples(fgaClient, [{ user: `user:${MEMBER}`, relation: 'member', object: `group:${groupFgaId(T, g)}` }]).catch(() => {})
  }
}

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
  db = await acquireTenantDb(asTenant(T))
  const space = await createSpace(db, fgaClient, { tenantId: T, userId: MANAGER, plan: 'free', name: 'group-grant-space' })
  spaceId = space.id
  const page = await createPage(db, fgaClient, app.searchDriver, { tenantId: T, spaceId, userId: MANAGER, title: 'Group Grant Page' })
  pageId = page.id
  // members.groups source rows (what listTenantGroups reads). MEMBER is in Engineering+Sales.
  await admin`INSERT INTO members (tenant_id, sub, email, groups) VALUES (${T}, ${MEMBER}, 'm@x.test', ${db.sql.array(['Engineering', 'Sales'])})
              ON CONFLICT (tenant_id, sub) DO UPDATE SET groups = EXCLUDED.groups`
  // A DIFFERENT tenant's member with its own group — must NOT leak into tenant_dev's list.
  await admin`INSERT INTO members (tenant_id, sub, email, groups) VALUES ('tenant_acme', 'acme-m', 'a@x.test', ${db.sql.array(['AcmeSecretTeam'])})
              ON CONFLICT (tenant_id, sub) DO UPDATE SET groups = EXCLUDED.groups`
  // FGA: MEMBER synced into Engineering (#111 path). STRANGER is in nothing.
  await cleanupFga()
  await syncMemberGroups(fgaClient, T, MEMBER, [], ['Engineering', 'Sales'])
})

afterAll(async () => {
  await revokeSpaceAccess(db, fgaClient, app.searchDriver, { spaceId, tenantId: T, userId: MANAGER, grantee: groupGrantee(T, GROUP), capability: 'view' }).catch(() => {})
  await cleanupFga()
  await admin`DELETE FROM members WHERE sub = ${MEMBER}`.catch(() => {})
  await admin`DELETE FROM members WHERE sub = 'acme-m'`.catch(() => {})
  await admin`DELETE FROM pages WHERE id = ${pageId}`.catch(() => {})
  await admin`DELETE FROM spaces WHERE id = ${spaceId}`.catch(() => {})
  await db.release()
  await app.close()
  await admin.end()
  await pool.end()
})

// #608: the sync CONVERGES — a stale mirror must not be able to fail a login. Measured on the device:
// a rebuilt FGA store left `members.groups` claiming a group whose tuple was gone, and the resulting
// "cannot delete a tuple which does not exist" threw out of establishMemberSession — the admin bounced
// to /login?error=access, and the e2e read it as "the console did not render".
describe('#608 the group sync converges instead of failing on a stale mirror', () => {
  // On a throwaway SUB, not on MEMBER: the #163 suite below depends on the beforeAll sync it received,
  // and the first cut of this test tore that state down as "cleanup" — turning two unrelated tests red.
  const GHOST = 'grant-grp-ghost-608'
  it('a delete whose tuple is already gone is convergence, not failure', async () => {
    // the stale shape: the mirror says the member carries Engineering; the store holds no such tuple
    await expect(
      syncMemberGroups(fgaClient, T, GHOST, ['Engineering'], []),
    ).resolves.toBeUndefined()
  })
  it('a write whose tuple already exists is convergence too', async () => {
    await syncMemberGroups(fgaClient, T, GHOST, [], ['Engineering']) // real write
    await expect(
      syncMemberGroups(fgaClient, T, GHOST, [], ['Engineering']), // mirror said [], store already has it
    ).resolves.toBeUndefined()
    // fga.check directly: checkRelation's ResourceRef is page|space by design, and this is a
    // structural read of a group tuple, not an application authz question
    const has = await fgaClient.check({ user: `user:${GHOST}`, relation: 'member', object: `group:${groupFgaId(T, GROUP)}` })
    expect(Boolean(has.allowed), 'and the goal state actually holds').toBe(true)
    await syncMemberGroups(fgaClient, T, GHOST, ['Engineering'], []) // real delete — leaves no residue
  })
})

describe('#163 grant access to a group by name', () => {
  it('groupGrantee resolves name → the SAME id the #111 sync wrote', () => {
    expect(groupGrantee(T, GROUP)).toBe(`group:${groupFgaId(T, GROUP)}#member`)
  })

  it('granting a space to a group by name lets a synced member view it; a non-member cannot', async () => {
    expect(await checkRelation(fgaClient, `user:${MEMBER}`, 'viewer', { type: 'space', id: spaceId })).toBe(false) // before
    await grantSpaceAccess(db, fgaClient, app.searchDriver, {
      spaceId, tenantId: T, userId: MANAGER, grantee: groupGrantee(T, GROUP), capability: 'view',
    })
    expect(await checkRelation(fgaClient, `user:${MEMBER}`, 'viewer', { type: 'space', id: spaceId })).toBe(true) // member of Engineering resolves
    // #258: a member VIEW grant also writes viewer_member (the member-only subset template#view inherits).
    expect(await checkRelation(fgaClient, `user:${MEMBER}`, 'viewer_member', { type: 'space', id: spaceId })).toBe(true)
    expect(await checkRelation(fgaClient, `user:${STRANGER}`, 'viewer', { type: 'space', id: spaceId })).toBe(false) // not in the group
    // the access list resolves the hashed grantee id back to the human group name (#163 display)
    const listed = await listSpaceAccess(fgaClient, db, { spaceId, tenantId: T, userId: MANAGER })
    expect(listed.find((g) => g.grantee === groupGrantee(T, GROUP))?.groupName).toBe('Engineering')
    await revokeSpaceAccess(db, fgaClient, app.searchDriver, {
      spaceId, tenantId: T, userId: MANAGER, grantee: groupGrantee(T, GROUP), capability: 'view',
    })
    expect(await checkRelation(fgaClient, `user:${MEMBER}`, 'viewer', { type: 'space', id: spaceId })).toBe(false) // revoke removes it
    expect(await checkRelation(fgaClient, `user:${MEMBER}`, 'viewer_member', { type: 'space', id: spaceId })).toBe(false) // #258: revoke removes the pair
  })

  it('granting a PAGE to a group by name resolves view for a synced member', async () => {
    await grantPageAccess(db, fgaClient, app.searchDriver, {
      pageId, tenantId: T, userId: MANAGER, grantee: groupGrantee(T, GROUP), relation: 'view',
    })
    expect(await checkRelation(fgaClient, `user:${MEMBER}`, 'view', { type: 'page', id: pageId })).toBe(true)
    expect(await checkRelation(fgaClient, `user:${STRANGER}`, 'view', { type: 'page', id: pageId })).toBe(false)
  })

  it('a grant to a group no longer in any member (renamed/emptied at IdP) shows the raw id (display fallback, ADR-053)', async () => {
    // groupFgaId is one-way: if "Ghost" appears in no member's groups, listSpaceAccess can't map the
    // hashed grantee back to a name → it falls back to the raw group:<id>#member (never crashes,
    // never shows a wrong name). The grant itself still resolves once a member syncs into "Ghost".
    const ghost = groupGrantee(T, 'Ghost')
    await grantSpaceAccess(db, fgaClient, app.searchDriver, { spaceId, tenantId: T, userId: MANAGER, grantee: ghost, capability: 'view' })
    const listed = await listSpaceAccess(fgaClient, db, { spaceId, tenantId: T, userId: MANAGER })
    const row = listed.find((g) => g.grantee === ghost)
    expect(row).toBeDefined()
    expect(row!.groupName).toBeUndefined() // unknown id → no name → UI shows the raw grantee
    await revokeSpaceAccess(db, fgaClient, app.searchDriver, { spaceId, tenantId: T, userId: MANAGER, grantee: ghost, capability: 'view' }).catch(() => {})
  })

  it('the group source is manage-gated and tenant-scoped (no cross-tenant leak)', async () => {
    const groups = await listTenantGroups(db, fgaClient, { spaceId, userId: MANAGER })
    expect(groups).toContain('Engineering')
    expect(groups).toContain('Sales')
    expect(groups).not.toContain('AcmeSecretTeam') // RLS: another tenant's group never leaks
  })

  it('a non-manager cannot list the group source (existence-leak gate)', async () => {
    await expect(listTenantGroups(db, fgaClient, { spaceId, userId: STRANGER }))
      .rejects.toMatchObject({ statusCode: 403 })
  })
})
