// #476 / ADR-178: an API key must stop working while its owner is deactivated — and start working
// again when they are not. Integration tests: real Postgres, real OpenFGA, no mocks.
//
// The freeze this defends against is a plan downgrade past the seat cap, which ADR-064 requires to be
// REVERSIBLE and to destroy nothing (keys included). So the key is never revoked; the check happens at
// authentication, which makes it exactly as reversible as the freeze. That is why the reversibility is
// pinned here and not just the refusal — a fix that revoked the key would pass "the frozen owner is
// refused" and quietly break the promise the whole design rests on.
//
// The owner is a sub of this file's own, never the shared `dev-user`: plan-freeze.test deactivates
// dev-user in this same shared tenant, and api-keys.test / api-key-scope.test authenticate as it.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { TenantRegistry } from '../db/registry.js'
import { acquireTenantDb } from '../db/tenant-db.js'
import type { TenantDb } from '../db/index.js'
import { verifyApiKey } from '../api-key-auth.js'
import { createApiKey } from '../routes/api-keys.js'
import type { Tenant } from '@wikistead/types'

const adminPool = postgres(process.env.DATABASE_ADMIN_URL!)
const OWNER = 'api-key-deactivation-476'
const OTHER = 'api-key-deactivation-476-other'

let tenant: Tenant
let db: TenantDb
let key: { id: string; plaintext: string }
let otherKey: { id: string; plaintext: string }

const setDeactivated = (sub: string, reason: string | null) =>
  adminPool`UPDATE members SET deactivated_at = ${reason ? new Date() : null}, deactivation_reason = ${reason}
            WHERE tenant_id = ${tenant.id} AND sub = ${sub}`

const keyRow = async (id: string) =>
  (await adminPool<{ revoked_at: Date | null; last_used_at: Date | null }[]>`
    SELECT revoked_at, last_used_at FROM api_keys WHERE id = ${id}`)[0]!

beforeAll(async () => {
  const registry = new TenantRegistry(pool)
  tenant = (await registry.findBySlug('dev'))!
  db = await acquireTenantDb(tenant)
  for (const sub of [OWNER, OTHER]) {
    await adminPool`INSERT INTO members (tenant_id, sub, role) VALUES (${tenant.id}, ${sub}, 'member')
                    ON CONFLICT (tenant_id, sub) DO UPDATE SET deactivated_at = NULL, deactivation_reason = NULL`
  }
  key = await createApiKey(db, { tenantId: tenant.id, plan: tenant.plan, ownerUserId: OWNER, name: 'deact-476' })
  otherKey = await createApiKey(db, { tenantId: tenant.id, plan: tenant.plan, ownerUserId: OTHER, name: 'deact-476-other' })
})

afterAll(async () => {
  await adminPool`DELETE FROM api_keys WHERE id IN (${key.id}, ${otherKey.id})`.catch(() => {})
  await adminPool`DELETE FROM members WHERE tenant_id = ${tenant.id} AND sub IN (${OWNER}, ${OTHER})`.catch(() => {})
  await db.release()
  await pool.end()
  await adminPool.end()
})

describe('#476 / ADR-178 — an API key follows its owner\'s deactivation', () => {
  it('refuses a frozen owner, leaves the key intact, and works again once the freeze lifts', async () => {
    // active → a principal
    const before = await verifyApiKey(key.plaintext, tenant.id)
    expect(before?.deactivated, 'the key authenticates while the owner is active').toBe(false)

    // frozen by a seat-cap downgrade → refused, and the refusal says which kind it is
    await setDeactivated(OWNER, 'downgrade_freeze')
    const frozen = await verifyApiKey(key.plaintext, tenant.id)
    expect(frozen, 'a valid key is not answered as unknown').not.toBeNull()
    expect(frozen?.deactivated, 'the frozen owner is refused').toBe(true)

    // the credential itself is untouched: a freeze must not look like a revocation, or the reversal
    // below would be a lie and the key would have to be re-issued
    const row = await keyRow(key.id)
    expect(row.revoked_at, 'a downgrade freeze never revokes the key').toBeNull()

    // …and the SAME key works again after the upgrade, with nothing re-issued
    await setDeactivated(OWNER, null)
    const thawed = await verifyApiKey(key.plaintext, tenant.id)
    expect(thawed?.deactivated, 'clearing the freeze restores the same key').toBe(false)
    expect(thawed as { sub: string }).toMatchObject({ sub: OWNER })
  })

  it('decides per request — no cached verdict survives the thaw or the freeze', async () => {
    await setDeactivated(OWNER, 'downgrade_freeze')
    expect((await verifyApiKey(key.plaintext, tenant.id))?.deactivated).toBe(true)
    await setDeactivated(OWNER, null)
    expect((await verifyApiKey(key.plaintext, tenant.id))?.deactivated).toBe(false)
    await setDeactivated(OWNER, 'scim')
    expect((await verifyApiKey(key.plaintext, tenant.id))?.deactivated, 'the other reason is refused too').toBe(true)
    await setDeactivated(OWNER, null)
  })

  it('answers a WRONG secret as unknown even when the owner is frozen (the check runs after the comparison)', async () => {
    // Deciding before the constant-time comparison would answer "the owner of this 12-character prefix
    // is deactivated" to someone who does not hold the secret — a prefix-only oracle. The observable
    // difference is exactly this: a bad secret must come back null, not "deactivated".
    await setDeactivated(OWNER, 'downgrade_freeze')
    const tampered = key.plaintext.slice(0, -4) + 'XXXX'
    expect(await verifyApiKey(tampered, tenant.id), 'a wrong secret is unknown, never "frozen"').toBeNull()
    await setDeactivated(OWNER, null)
  })

  it('does not move last_used_at for a refused request', async () => {
    await verifyApiKey(key.plaintext, tenant.id) // stamp it while active
    await new Promise((r) => setTimeout(r, 250))
    await setDeactivated(OWNER, 'downgrade_freeze')
    const before = (await keyRow(key.id)).last_used_at
    await verifyApiKey(key.plaintext, tenant.id)
    await new Promise((r) => setTimeout(r, 400)) // the update is fire-and-forget; give it time to NOT happen
    const after = (await keyRow(key.id)).last_used_at
    expect(after?.getTime() ?? null, 'a refused request is not a use').toBe(before?.getTime() ?? null)
    await setDeactivated(OWNER, null)
  })

  it('freezes one owner without touching another member of the same tenant', async () => {
    await setDeactivated(OWNER, 'downgrade_freeze')
    expect((await verifyApiKey(key.plaintext, tenant.id))?.deactivated).toBe(true)
    expect((await verifyApiKey(otherKey.plaintext, tenant.id))?.deactivated, 'an active member is unaffected').toBe(false)
    await setDeactivated(OWNER, null)
  })

  it('does not reach across tenants — a frozen sub elsewhere is not this tenant\'s member', async () => {
    // The lookup runs inside withTenantTx, so RLS scopes BOTH tables. Freeze a same-named sub in
    // another tenant and this tenant's key must be unaffected.
    const registry = new TenantRegistry(pool)
    const others = await adminPool<{ id: string }[]>`SELECT id FROM tenants WHERE id <> ${tenant.id} LIMIT 1`
    if (!others.length) return // single-tenant dev stack — nothing to cross
    const otherTenantId = others[0]!.id
    await adminPool`INSERT INTO members (tenant_id, sub, role, deactivated_at, deactivation_reason)
                    VALUES (${otherTenantId}, ${OWNER}, 'member', now(), 'downgrade_freeze')
                    ON CONFLICT (tenant_id, sub) DO UPDATE SET deactivated_at = now(), deactivation_reason = 'downgrade_freeze'`
    try {
      const still = await verifyApiKey(key.plaintext, tenant.id)
      expect(still?.deactivated, "another tenant's freeze does not reach this key").toBe(false)
    } finally {
      await adminPool`DELETE FROM members WHERE tenant_id = ${otherTenantId} AND sub = ${OWNER}`.catch(() => {})
      void registry
    }
  })
})
