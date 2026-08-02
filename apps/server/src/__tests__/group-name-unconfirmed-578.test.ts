// #578 bounce ①: granting to a group nobody carries yet must not read as "unknown group".
//
// A group's FGA id is a one-way hash of its name, so a listing can only show a name by reversing the
// id against names the product knows. That set was `members.groups` UNION the mappings' own
// `group_name`. Retiring the space mappings (slice 3) removed the only place a name nobody carries
// yet was written down — so the picker accepted a typed name, the grant landed correctly, and the row
// came back nameless. The access was right and the screen was wrong, which is the worst shape for a
// permissions surface.
//
// The name now rides on the assignment. Two facts stay apart, because they lead to different actions:
//   - "not seen yet": we know the name, nobody has signed in carrying it. Normal, and temporary.
//   - "unknown group": the id resolves to no name at all (the group was renamed or emptied at the IdP
//     after the grant). The row keeps its revoke — unreadable must never mean unremovable (#536).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { fgaClient } from '@wikistead/authz'
import { createSpace, deleteSpace, grantSpaceAccess, listSpaceAccess } from '../routes/spaces.js'
import { groupGrantee } from '../auth/group-sync.js'
import { buildApp } from '../app.js'
import type { Tenant } from '@wikistead/types'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const TENANT = 'tenant_dev'
const STAMP = Date.now().toString(36)
const OWNER = 'dev-user'
const NEW_GROUP = `Contractors-${STAMP}` // nobody carries this one
const REAL_GROUP = `Engineering-${STAMP}` // a member will carry this one
const MEMBER = `gnu578-${STAMP}`
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'business', isolation: 'logical' }) as Tenant

let app: FastifyInstance
let db: TenantDb
let spaceId = ''

const rowsFor = async (name: string) => {
  const grantee = groupGrantee(TENANT, name)
  const all = await listSpaceAccess(fgaClient, db, { spaceId, tenantId: TENANT, userId: OWNER })
  return all.filter((g) => g.grantee === grantee)
}

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
  db = await acquireTenantDb(asTenant(TENANT))
  spaceId = (await createSpace(db, fgaClient, { tenantId: TENANT, userId: OWNER, plan: 'business', name: `gnu578-${STAMP}` })).id
}, 180_000)

afterAll(async () => {
  await admin`DELETE FROM role_assignments WHERE resource_id = ${spaceId}`.catch(() => {})
  await admin`DELETE FROM members WHERE tenant_id = ${TENANT} AND sub = ${MEMBER}`.catch(() => {})
  await deleteSpace(db, fgaClient, app.searchDriver, { tenantId: TENANT, spaceId, userId: OWNER }).catch(() => {})
  await admin`DELETE FROM search_outbox WHERE tenant_id = ${TENANT}`.catch(() => {})
  await db.release(); await app.close(); await admin.end(); await pool.end()
}, 180_000)

describe('#578 ①: a grant to a group the directory has not produced yet keeps its name', () => {
  it('the listing returns the typed name, marked as not seen yet', async () => {
    await grantSpaceAccess(db, fgaClient, app.searchDriver, {
      spaceId, tenantId: TENANT, userId: OWNER, grantee: groupGrantee(TENANT, NEW_GROUP),
      capability: 'view', plan: 'business', groupName: NEW_GROUP,
    })
    const [row] = await rowsFor(NEW_GROUP)
    expect(row, 'the grant is listed').toBeTruthy()
    expect(row!.groupName, 'the name the manager typed, not a hash and not nothing').toBe(NEW_GROUP)
    expect(row!.groupUnconfirmed, 'and it is marked, because nobody carries it yet').toBe(true)
  }, 180_000)

  it('the mark disappears once somebody signs in carrying the group', async () => {
    await grantSpaceAccess(db, fgaClient, app.searchDriver, {
      spaceId, tenantId: TENANT, userId: OWNER, grantee: groupGrantee(TENANT, REAL_GROUP),
      capability: 'view', plan: 'business', groupName: REAL_GROUP,
    })
    expect((await rowsFor(REAL_GROUP))[0]!.groupUnconfirmed, 'before anyone carries it').toBe(true)

    // what a login does: the member row records the groups the IdP asserted
    await admin`INSERT INTO members (tenant_id, sub, email, display_name, role, groups)
                VALUES (${TENANT}, ${MEMBER}, ${`${MEMBER}@t.test`}, ${MEMBER}, 'member', ${[REAL_GROUP]})`
    const [after] = await rowsFor(REAL_GROUP)
    expect(after!.groupName, 'still named').toBe(REAL_GROUP)
    expect(after!.groupUnconfirmed, 'no longer marked — the directory has produced it').toBeUndefined()
  }, 180_000)

  it('a name nothing can resolve is still a DIFFERENT answer (no name at all)', async () => {
    // the pre-#578 shape: a grant whose group was never named here. It must come back nameless so the
    // screen can say "unknown group" — conflating it with "not seen yet" would tell a manager to wait
    // for a login that is never coming.
    const orphan = `Ghost-${STAMP}`
    await grantSpaceAccess(db, fgaClient, app.searchDriver, {
      spaceId, tenantId: TENANT, userId: OWNER, grantee: groupGrantee(TENANT, orphan),
      capability: 'view', plan: 'business', groupName: orphan,
    })
    await admin`UPDATE role_assignments SET group_name = NULL
                WHERE resource_id = ${spaceId} AND principal = ${groupGrantee(TENANT, orphan)}`
    const [row] = await rowsFor(orphan)
    expect(row!.groupName, 'nothing to show').toBeUndefined()
    expect(row!.groupUnconfirmed, 'and no mark either — the two are not the same fact').toBeUndefined()
    expect(row!.capability, 'the row survives so its revoke stays reachable').toBe('view')
  }, 180_000)
})
