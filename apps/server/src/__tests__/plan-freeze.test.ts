// Plan-downgrade seat freeze (#131 / ADR-064 sub-task 3). On a committed downgrade the
// reconcile batch DEACTIVATES over-cap members (newest-first, admins protected) — reversible,
// no deletes; a deactivated member can't establish a session. authz/billing-critical.
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import postgres from 'postgres'
import IORedis from 'ioredis'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { fgaClient } from '@wikistead/authz'
import { establishMemberSession } from '../auth/session.js'
import { reconcilePlans } from '../scripts/plan-reconcile.js'
import { UNLIMITED, registerEntitlementsResolver, resetEntitlementsResolver } from '@wikistead/entitlements'
import type { Tenant } from '@wikistead/types'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const valkey = new IORedis(process.env.VALKEY_URL ?? 'redis://localhost:6379')
const TENANT = 'tenant_dev'
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'free', isolation: 'logical' }) as Tenant
const SUBS = ['frz-old', 'frz-mid', 'frz-new'] // inserted oldest→newest
let db: TenantDb, savedPlan = 'free'

beforeAll(async () => {
  db = await acquireTenantDb(asTenant(TENANT))
  const [t] = await admin<{ plan: string }[]>`SELECT plan FROM tenants WHERE id = ${TENANT}`
  savedPlan = t.plan
  // Three non-admin members with staggered created_at (oldest first).
  for (let i = 0; i < SUBS.length; i++) {
    await admin`INSERT INTO members (tenant_id, sub, role, created_at) VALUES (${TENANT}, ${SUBS[i]}, 'member', now() + make_interval(secs => ${i}))
                ON CONFLICT (tenant_id, sub) DO UPDATE SET role = 'member', deactivated_at = NULL`
  }
}, 30_000)
afterEach(() => resetEntitlementsResolver())
afterAll(async () => {
  resetEntitlementsResolver()
  await admin`DELETE FROM members WHERE tenant_id = ${TENANT} AND sub = ANY(${admin.array(SUBS)})`.catch(() => {})
  await admin`UPDATE tenants SET plan = ${savedPlan}, pending_plan = NULL, pending_plan_at = NULL WHERE id = ${TENANT}`.catch(() => {})
  await admin`UPDATE members SET deactivated_at = NULL WHERE tenant_id = ${TENANT}`.catch(() => {})
  await db.release(); await admin.end(); await valkey.quit(); await pool.end()
}, 30_000)

describe('seat freeze on downgrade commit (#131)', () => {
  it('deactivates over-cap members NEWEST-first, protects admins, deletes nothing', async () => {
    // maxSeats 2: dev-user (admin) consumes 1 seat → 1 seat for non-admins → keep oldest 1,
    // freeze the newer 2. (UNLIMITED everywhere else so unrelated gates don't interfere.)
    registerEntitlementsResolver(() => ({ ...UNLIMITED, maxSeats: 2 }))
    await admin`UPDATE members SET deactivated_at = NULL WHERE tenant_id = ${TENANT}`
    await admin`UPDATE tenants SET plan = 'pro', pending_plan = 'free', pending_plan_at = now() WHERE id = ${TENANT}`

    await reconcilePlans(admin, { graceSeconds: 0 }) // commit + freeze

    const rows = await admin<{ sub: string; deactivated_at: Date | null }[]>`
      SELECT sub, deactivated_at FROM members WHERE tenant_id = ${TENANT} AND sub = ANY(${admin.array(SUBS)}) ORDER BY created_at ASC`
    expect(rows.map((r) => r.deactivated_at === null)).toEqual([true, false, false]) // oldest kept, newer 2 frozen
    // Admin (dev-user) is never frozen.
    const [adminRow] = await admin<{ deactivated_at: Date | null }[]>`SELECT deactivated_at FROM members WHERE tenant_id = ${TENANT} AND sub = 'dev-user'`
    expect(adminRow.deactivated_at).toBeNull()
    // Nothing deleted — all three rows still exist (data kept, reversible).
    expect(rows).toHaveLength(3)
  })

  it('a deactivated member cannot establish a session (403); clearing it restores login', async () => {
    await admin`UPDATE members SET deactivated_at = now() WHERE tenant_id = ${TENANT} AND sub = 'dev-user'`
    try {
      await expect(establishMemberSession({ db, fga: fgaClient, valkey }, { id: TENANT }, { sub: 'dev-user' }))
        .rejects.toMatchObject({ statusCode: 403, code: 'member_deactivated' })
    } finally {
      await admin`UPDATE members SET deactivated_at = NULL WHERE tenant_id = ${TENANT} AND sub = 'dev-user'`
    }
    // Reactivated → a session is created again.
    const sid = await establishMemberSession({ db, fga: fgaClient, valkey }, { id: TENANT }, { sub: 'dev-user' })
    expect(typeof sid).toBe('string')
  })
})
