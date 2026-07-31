// #497 / ADR-183 §2b: tenant admin conferred by an IdP group, MATERIALISED per user.
//
// This is the highest-blast-radius grant in the product, and the review that approved it approved a
// specific SHAPE, so the tests pin the shape rather than "it works":
//   - the FGA model is NOT opened up. `tenant#admin` still refuses a group principal — the whole reason
//     for materialisation is that a group leaf would confer admin with no action and no record on our
//     side. If someone ever adds that leaf, the first test here goes red.
//   - a MANUAL admin is never demoted by a vanishing IdP group. Provenance is the only thing separating
//     the two, so it is asserted directly.
//   - the LAST admin is never demoted — a tenant locked out of its own administration cannot be repaired
//     from inside the product, and an IdP group edit must not do what the console refuses to.
//   - the drift sweep actually revokes. Login is not a revocation path (the member may never sign in
//     again, and since #496 their API key keeps working), so this is the load-bearing one.
// Real Postgres + OpenFGA (the evaluator writes real tuples and the checks read them back).
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import postgres from 'postgres'
import { randomUUID } from 'node:crypto'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { fgaClient, writeTuples, deleteTuples, isTenantAdmin } from '@wikistead/authz'
import { evaluateAdminMapping, reconcileMaterialisedAdmins } from '../auth/admin-mapping.js'
import type { Tenant } from '@wikistead/types'

const adminPool = postgres(process.env.DATABASE_ADMIN_URL!)
// A tenant of this suite's OWN, never the shared dev one. These cases mutate members.role and, for the
// last-admin guard, have to remove the tenant's other admins — doing that in tenant_dev silently changed
// the seat counts and admin counts other suites assert on (it turned six unrelated files red once).
const SLUG = `am497-${Date.now().toString(36)}`
let TENANT = ''
let tenant = { id: '', plan: 'business' }
const asTenant = (id: string): Tenant => ({ id, slug: SLUG, plan: 'business', isolation: 'logical' }) as Tenant

const GROUP = 'idp-admins-497'
const VIA_GROUP = 'am-via-group'     // becomes admin because of the mapping
const HAND = 'am-by-hand'            // appointed by a person; the mapping must never touch them
const ANCHOR = 'am-anchor-admin'     // exists so the last-admin guard never masks a real demotion

let db: TenantDb
const subs = [VIA_GROUP, HAND, ANCHOR]

const adminTuple = (sub: string) => ({ user: `user:${sub}`, relation: 'admin', object: `tenant:${TENANT}` })

async function seedMember(sub: string, opts: { role: string; adminOrigin?: string; groups?: string[] }) {
  await db.sql`
    INSERT INTO members (tenant_id, sub, role, admin_origin, groups)
    VALUES (${TENANT}, ${sub}, ${opts.role}, ${opts.adminOrigin ?? 'manual'}, ${db.sql.array(opts.groups ?? [])})
    ON CONFLICT (tenant_id, sub) DO UPDATE SET role = EXCLUDED.role, admin_origin = EXCLUDED.admin_origin, groups = EXCLUDED.groups`
  await writeTuples(fgaClient, [{ user: `user:${sub}`, relation: 'member', object: `tenant:${TENANT}` }]).catch(() => {})
  if (opts.role === 'admin') await writeTuples(fgaClient, [adminTuple(sub)]).catch(() => {})
}

const memberRow = async (sub: string) =>
  (await db.sql<{ role: string; admin_origin: string }[]>`SELECT role, admin_origin FROM members WHERE sub = ${sub}`)[0]

beforeAll(async () => {
  const [t] = await adminPool<{ id: string }[]>`INSERT INTO tenants (slug, plan) VALUES (${SLUG}, 'business') RETURNING id`
  TENANT = t.id
  tenant = { id: TENANT, plan: 'business' }
  db = await acquireTenantDb(asTenant(TENANT))
}, 60_000)

afterAll(async () => {
  for (const sub of subs) {
    await deleteTuples(fgaClient, [adminTuple(sub)]).catch(() => {})
    await deleteTuples(fgaClient, [{ user: `user:${sub}`, relation: 'member', object: `tenant:${TENANT}` }]).catch(() => {})
  }
  await adminPool`DELETE FROM group_admin_mappings WHERE tenant_id = ${TENANT}`.catch(() => {})
  await adminPool`DELETE FROM members WHERE tenant_id = ${TENANT}`.catch(() => {})
  // The tenant row goes away below, so anything still REFERRING to it must go first: an undrained
  // audit_outbox row whose tenant no longer exists can never be drained (withTenantTx cannot resolve it)
  // and just accumulates in the shared stack.
  await adminPool`DELETE FROM audit_outbox WHERE tenant_id = ${TENANT}`.catch(() => {})
  await adminPool`DELETE FROM audit_log WHERE tenant_id = ${TENANT}`.catch(() => {})
  await db.release()
  await adminPool`DELETE FROM tenants WHERE id = ${TENANT}`.catch(() => {})
  await adminPool.end(); await pool.end()
}, 60_000)

beforeEach(async () => {
  await adminPool`DELETE FROM group_admin_mappings WHERE tenant_id = ${TENANT}`
  for (const sub of subs) await deleteTuples(fgaClient, [adminTuple(sub)]).catch(() => {})
  await adminPool`DELETE FROM members WHERE tenant_id = ${TENANT}`
  // The anchor keeps the tenant's admin count above one so the last-admin guard never silently absorbs
  // a demotion this suite is trying to observe.
  await seedMember(ANCHOR, { role: 'admin', adminOrigin: 'manual' })
})

async function addMapping(groupName = GROUP) {
  await db.sql`
    INSERT INTO group_admin_mappings (id, tenant_id, group_name, created_by)
    VALUES (${randomUUID()}, ${TENANT}, ${groupName}, 'seed')`
}

describe('#497 §2b — admin materialisation is per user, and the model stays shut', () => {
  it('the FGA model still REFUSES a group principal on tenant#admin (option (a) stays rejected)', async () => {
    // If this ever succeeds, the mapping table has become a live authz leaf and every guard in this file
    // is bypassable by editing a group in the IdP.
    await expect(
      writeTuples(fgaClient, [{ user: `group:${GROUP}#member`, relation: 'admin', object: `tenant:${TENANT}` }]),
    ).rejects.toThrow(/type restriction/i) // the MODEL refused it, not a dead connection
    // Control: the same write with a user principal succeeds, so the refusal above is the model talking
    // and not an unreachable store making every assertion pass.
    await writeTuples(fgaClient, [adminTuple(ANCHOR)]).catch(() => {})
    expect(await isTenantAdmin(fgaClient, ANCHOR, TENANT)).toBe(true)
  })

  it('materialises admin for a member carrying the mapped group, with mapping provenance', async () => {
    await addMapping()
    await seedMember(VIA_GROUP, { role: 'member', groups: [GROUP] })
    expect(await isTenantAdmin(fgaClient, VIA_GROUP, TENANT), 'not admin before').toBe(false)

    expect(await evaluateAdminMapping(db, fgaClient, tenant, VIA_GROUP, [GROUP])).toBe('promoted')
    expect(await isTenantAdmin(fgaClient, VIA_GROUP, TENANT), 'the tuple is the authority').toBe(true)
    expect(await memberRow(VIA_GROUP)).toMatchObject({ role: 'admin', admin_origin: 'mapping' })

    // Idempotent: a second login must not churn or re-audit.
    expect(await evaluateAdminMapping(db, fgaClient, tenant, VIA_GROUP, [GROUP])).toBe('unchanged')
  })

  it('withdraws it when the member stops carrying the group', async () => {
    await addMapping()
    await seedMember(VIA_GROUP, { role: 'member', groups: [GROUP] })
    await evaluateAdminMapping(db, fgaClient, tenant, VIA_GROUP, [GROUP])

    expect(await evaluateAdminMapping(db, fgaClient, tenant, VIA_GROUP, [])).toBe('demoted')
    expect(await isTenantAdmin(fgaClient, VIA_GROUP, TENANT), 'the tuple is gone, not just the row').toBe(false)
    expect(await memberRow(VIA_GROUP)).toMatchObject({ role: 'member', admin_origin: 'manual' })
  })

  it('NEVER demotes a hand-appointed admin whose IdP group disappears (provenance is load-bearing)', async () => {
    await addMapping()
    await seedMember(HAND, { role: 'admin', adminOrigin: 'manual', groups: [GROUP] })

    // The group vanishes from the IdP. A person appointed this admin; only a person may unappoint them.
    expect(await evaluateAdminMapping(db, fgaClient, tenant, HAND, [])).toBe('unchanged')
    expect(await isTenantAdmin(fgaClient, HAND, TENANT)).toBe(true)
    expect(await memberRow(HAND)).toMatchObject({ role: 'admin', admin_origin: 'manual' })
  })

  it('does not overwrite a manual admin with mapping provenance when the group matches', async () => {
    // Otherwise the next group edit could demote someone who was appointed by hand — laundering a manual
    // appointment into a machine-managed one.
    await addMapping()
    await seedMember(HAND, { role: 'admin', adminOrigin: 'manual', groups: [GROUP] })
    expect(await evaluateAdminMapping(db, fgaClient, tenant, HAND, [GROUP])).toBe('unchanged')
    expect(await memberRow(HAND)).toMatchObject({ admin_origin: 'manual' })
  })

  it('refuses to demote the LAST admin, even when the mapping no longer matches', async () => {
    await addMapping()
    await seedMember(VIA_GROUP, { role: 'member', groups: [GROUP] })
    await evaluateAdminMapping(db, fgaClient, tenant, VIA_GROUP, [GROUP])
    // Remove every other admin so the materialised one is all that is left.
    await adminPool`DELETE FROM members WHERE tenant_id = ${TENANT} AND role = 'admin' AND sub <> ${VIA_GROUP}`

    expect(await evaluateAdminMapping(db, fgaClient, tenant, VIA_GROUP, [])).toBe('unchanged')
    expect(await isTenantAdmin(fgaClient, VIA_GROUP, TENANT), 'the tenant keeps an administrator').toBe(true)
  })

  it('the DRIFT SWEEP revokes an admin who never signs in again', async () => {
    // The reason the sweep is required at v1: login corrects the member who shows up, and this one does
    // not — while (since #496) their API key keeps authenticating.
    await addMapping()
    await seedMember(VIA_GROUP, { role: 'member', groups: [GROUP] })
    await evaluateAdminMapping(db, fgaClient, tenant, VIA_GROUP, [GROUP])
    expect(await isTenantAdmin(fgaClient, VIA_GROUP, TENANT)).toBe(true)

    // The IdP drops the group from the member's record. Nothing else happens — no login, no SCIM call.
    await db.sql`UPDATE members SET groups = ${db.sql.array([])} WHERE sub = ${VIA_GROUP}`

    expect(await reconcileMaterialisedAdmins(fgaClient)).toBeGreaterThanOrEqual(1)
    expect(await isTenantAdmin(fgaClient, VIA_GROUP, TENANT), 'revoked without the member doing anything').toBe(false)
    expect(await memberRow(VIA_GROUP)).toMatchObject({ role: 'member', admin_origin: 'manual' })
  })

  it('a row the sweep cannot process does NOT stop it revoking the others (blocker 1)', async () => {
    // SCIM deprovision (ee-server scim/provision.ts) deletes the admin tuple and empties the member's
    // groups but leaves role='admin'/admin_origin='mapping' behind. The sweep then tries to delete a
    // tuple that is not there, which OpenFGA treats as an error — and with one try/catch around the whole
    // tenant loop that single row made the sweep a no-op, so REAL drifted admins kept their access
    // indefinitely. This pins the blast radius of one bad row at one row.
    await addMapping()
    const DEPROVISIONED = 'am-deprovisioned'
    subs.push(DEPROVISIONED)
    await db.sql`
      INSERT INTO members (tenant_id, sub, role, admin_origin, groups)
      VALUES (${TENANT}, ${DEPROVISIONED}, 'admin', 'mapping', ${db.sql.array([])})
      ON CONFLICT (tenant_id, sub) DO UPDATE SET role = 'admin', admin_origin = 'mapping', groups = ${db.sql.array([])}`
    // deliberately NO admin tuple for this one — that is the shape deprovision leaves behind

    // A genuine drifted admin, sorted after the broken row is irrelevant: neither may be skipped.
    await seedMember(VIA_GROUP, { role: 'member', groups: [GROUP] })
    await evaluateAdminMapping(db, fgaClient, tenant, VIA_GROUP, [GROUP])
    await db.sql`UPDATE members SET groups = ${db.sql.array([])} WHERE sub = ${VIA_GROUP}`

    await reconcileMaterialisedAdmins(fgaClient)
    expect(await isTenantAdmin(fgaClient, VIA_GROUP, TENANT), 'the real drift admin is still revoked').toBe(false)
    // And the tuple-less row is reconciled too rather than retried forever: absent IS the target state.
    expect(await memberRow(DEPROVISIONED)).toMatchObject({ role: 'member', admin_origin: 'manual' })
  })

  it('a row that fails for an UNTOLERATED reason still costs only itself (gap 1)', async () => {
    // The previous regression only pinned the tuple-tolerance half. Per-row ISOLATION is a separate
    // property, and with the tolerance in place it stayed green even with the guard back around the whole
    // loop — so it was not actually guarded. This drives a row whose demotion throws for a reason the
    // tolerance does NOT cover: a sub that cannot form a legal FGA principal, which the store rejects as a
    // validation error rather than a missing tuple. Bad rows like this are exactly what one wants isolated.
    await addMapping()
    const BAD = 'am bad sub with spaces'
    subs.push(BAD)
    await db.sql`
      INSERT INTO members (tenant_id, sub, role, admin_origin, groups)
      VALUES (${TENANT}, ${BAD}, 'admin', 'mapping', ${db.sql.array([])})
      ON CONFLICT (tenant_id, sub) DO UPDATE SET role = 'admin', admin_origin = 'mapping'`

    const GOOD = VIA_GROUP
    await seedMember(GOOD, { role: 'member', groups: [GROUP] })
    await evaluateAdminMapping(db, fgaClient, tenant, GOOD, [GROUP])
    await db.sql`UPDATE members SET groups = ${db.sql.array([])} WHERE sub = ${GOOD}`

    await reconcileMaterialisedAdmins(fgaClient)
    expect(await isTenantAdmin(fgaClient, GOOD, TENANT), 'the healthy row is still revoked').toBe(false)
  })

  it('the drift sweep leaves manual admins and still-matching members alone', async () => {
    await addMapping()
    await seedMember(HAND, { role: 'admin', adminOrigin: 'manual', groups: [] })   // manual, no group at all
    await seedMember(VIA_GROUP, { role: 'member', groups: [GROUP] })
    await evaluateAdminMapping(db, fgaClient, tenant, VIA_GROUP, [GROUP])          // materialised, still matching

    await reconcileMaterialisedAdmins(fgaClient)
    expect(await isTenantAdmin(fgaClient, HAND, TENANT), 'manual survives the sweep').toBe(true)
    expect(await isTenantAdmin(fgaClient, VIA_GROUP, TENANT), 'still in the group, still admin').toBe(true)
  })

  it('a mapping in ANOTHER tenant confers nothing here (RLS scopes the lookup)', async () => {
    // The mapping table is FORCE RLS; this pins that the evaluator reads it through the tenant handle
    // rather than a bare pool, which would let one tenant's group name mint admins in another.
    const other = `tenant_am_${Date.now().toString(36)}`
    await adminPool`INSERT INTO tenants (id, slug, plan) VALUES (${other}, ${other}, 'business')`
    try {
      await adminPool`INSERT INTO group_admin_mappings (id, tenant_id, group_name, created_by) VALUES (${randomUUID()}, ${other}, ${GROUP}, 'seed')`
      await seedMember(VIA_GROUP, { role: 'member', groups: [GROUP] })
      expect(await evaluateAdminMapping(db, fgaClient, tenant, VIA_GROUP, [GROUP])).toBe('unchanged')
      expect(await isTenantAdmin(fgaClient, VIA_GROUP, TENANT)).toBe(false)
    } finally {
      await adminPool`DELETE FROM group_admin_mappings WHERE tenant_id = ${other}`
      await adminPool`DELETE FROM tenants WHERE id = ${other}`
    }
  })
})

// #573 re-review NEW-1: the sweep carried a FOURTH hand-written copy of the last-admin predicate —
// seventy lines below the real one and the only one missing the deactivated exclusion. A
// SCIM-suspended admin therefore counted as "someone else is admin", and the sweep demoted the last
// LIVE one: the tenant loses its own administration through a background worker, which is the exact
// lockout #573 closed at the SCIM door.
describe('#573 NEW-1: a suspended admin is not a way back in, so the sweep must not demote the last live one', () => {
  it('leaves the drifted admin in place when the only other admin is deactivated', async () => {
    const SUSPENDED = 'am-suspended-573'
    subs.push(SUSPENDED)
    await addMapping()
    // the only other admin is SCIM-suspended: role='admin' in the row, but cannot log in
    await seedMember(SUSPENDED, { role: 'admin' })
    await db.sql`UPDATE members SET deactivated_at = now(), deactivation_reason = 'scim' WHERE tenant_id = ${TENANT} AND sub = ${SUSPENDED}`
    await adminPool`UPDATE members SET role = 'member' WHERE tenant_id = ${TENANT} AND sub = ${ANCHOR}`

    // a genuinely drifted mapping admin — the sweep's normal target
    await seedMember(VIA_GROUP, { role: 'member', groups: [GROUP] })
    await evaluateAdminMapping(db, fgaClient, tenant, VIA_GROUP, [GROUP])
    await db.sql`UPDATE members SET groups = ${db.sql.array([])} WHERE sub = ${VIA_GROUP}`

    await reconcileMaterialisedAdmins(fgaClient)
    expect(await memberRow(VIA_GROUP), 'the last LIVE admin survives the sweep').toMatchObject({ role: 'admin' })
    expect(await isTenantAdmin(fgaClient, VIA_GROUP, TENANT), 'and keeps administering').toBe(true)
  })
})
