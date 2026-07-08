// #226 / ADR-106: the default personal space. ensurePersonalSpace makes an OWNER-ONLY space on first
// sign-in — invisible to ordinary members (existence-hidden, name not leaked), visible to the tenant admin
// (decision 1(a): = hidden from ordinary members, NOT from an admin), idempotent, and its
// pages are viewable only by owner + admin (so search never surfaces them to a non-admin member). Sharing
// rides the existing manage-gated grant path, which rejects public / guest principals (public⊥ preserved).
// Real Postgres + OpenFGA.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { fgaClient } from '@wikistead/authz'
import { LogicalSearchDriver } from '../search/index.js'
import { ensurePersonalSpace, listSpaces, grantSpaceAccess } from '../routes/spaces.js'
import { createPage, deletePage } from '../routes/pages.js'
import { TenantRegistry } from '../db/registry.js'
import type { Tenant } from '@wikistead/types'

const driver = new LogicalSearchDriver()
const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const T = 'tenant_dev'
const OWNER = 'ps226-owner'
const STRANGER = 'ps226-stranger' // an ordinary member — must NOT see OWNER's personal space
const ADMIN = 'dev-user'          // tenant_dev's seeded admin → admin from tenant

let tenant: Tenant
let db: TenantDb
let personalSpaceId = ''
const pageIds: string[] = []

async function personalSpaceOf(sub: string): Promise<string | null> {
  const [r] = await admin<{ id: string }[]>`SELECT id FROM spaces WHERE tenant_id = ${T} AND personal_owner_sub = ${sub} LIMIT 1`
  return r?.id ?? null
}

beforeAll(async () => {
  tenant = (await new TenantRegistry(pool).findBySlug('dev'))!
  db = await acquireTenantDb(tenant)
  await ensurePersonalSpace(db, fgaClient, { tenantId: T, userId: OWNER, name: 'Owner', plan: tenant.plan })
  personalSpaceId = (await personalSpaceOf(OWNER))!
}, 60_000)

afterAll(async () => {
  for (const id of pageIds) await deletePage(db, fgaClient, driver, { pageId: id, userId: OWNER }).catch(() => {})
  if (personalSpaceId) {
    await fgaClient.write({ deletes: (await fgaClient.read({ object: `space:${personalSpaceId}` })).tuples?.map((t) => t.key!).filter(Boolean) ?? [] }).catch(() => {})
    await admin`DELETE FROM spaces WHERE id = ${personalSpaceId}`.catch(() => {})
  }
  await db.release(); await pool.end(); await admin.end()
}, 60_000)

const check = (user: string, relation: string, obj: string) =>
  fgaClient.check({ user, relation, object: obj }).then((r) => r.allowed ?? false)

describe('#226 default personal space', () => {
  it('creates exactly one owner-only space (idempotent on a second call)', async () => {
    await ensurePersonalSpace(db, fgaClient, { tenantId: T, userId: OWNER, name: 'Owner again', plan: tenant.plan })
    const rows = await admin<{ id: string }[]>`SELECT id FROM spaces WHERE tenant_id = ${T} AND personal_owner_sub = ${OWNER}`
    expect(rows.length).toBe(1) // one member = one personal space (UNIQUE index)
  })

  it('is visible to the owner, HIDDEN from an ordinary member, VISIBLE to the tenant admin', async () => {
    const ownerSees = (await listSpaces(db, fgaClient, OWNER)).map((s) => s.id)
    const strangerSees = (await listSpaces(db, fgaClient, STRANGER)).map((s) => s.id)
    const adminSees = (await listSpaces(db, fgaClient, ADMIN)).map((s) => s.id)
    expect(ownerSees).toContain(personalSpaceId)
    expect(strangerSees).not.toContain(personalSpaceId) // existence-hidden from ordinary members
    expect(adminSees).toContain(personalSpaceId)        // decision 1(a): admin can see it
  })

  it('a page in the personal space is viewable ONLY by the owner and the admin (search boundary)', async () => {
    const p = await createPage(db, fgaClient, driver, { tenantId: T, spaceId: personalSpaceId, userId: OWNER, title: 'Private note' })
    pageIds.push(p.id)
    // publish so it would be search-indexable; the visibility gate (space viewer = owner + admin) still holds.
    await admin`UPDATE pages SET published_md = 'note', published_at = now() WHERE id = ${p.id}`
    await fgaClient.write({ writes: [{ user: `space:${personalSpaceId}`, relation: 'space', object: `page:${p.id}` }] })
    expect(await check(`user:${OWNER}`, 'view', `page:${p.id}`)).toBe(true)
    expect(await check(`user:${ADMIN}`, 'view', `page:${p.id}`)).toBe(true)
    expect(await check(`user:${STRANGER}`, 'view', `page:${p.id}`)).toBe(false) // never surfaces to a non-admin member
  })

  it('sharing rejects public (user:*) and guest (share_link) principals (public⊥ preserved)', async () => {
    await expect(
      grantSpaceAccess(db, fgaClient, driver, { spaceId: personalSpaceId, tenantId: T, userId: OWNER, grantee: 'user:*', capability: 'view' }),
    ).rejects.toMatchObject({ statusCode: 400 })
    await expect(
      grantSpaceAccess(db, fgaClient, driver, { spaceId: personalSpaceId, tenantId: T, userId: OWNER, grantee: 'share_link:x', capability: 'view' }),
    ).rejects.toMatchObject({ statusCode: 400 })
  })

  it('sharing with a real member grant makes the space visible to them (owner can share)', async () => {
    await grantSpaceAccess(db, fgaClient, driver, { spaceId: personalSpaceId, tenantId: T, userId: OWNER, grantee: `user:${STRANGER}`, capability: 'view' })
    const strangerSees = (await listSpaces(db, fgaClient, STRANGER)).map((s) => s.id)
    expect(strangerSees).toContain(personalSpaceId) // now shared → visible
  })
})
