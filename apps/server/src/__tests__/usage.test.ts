// Integration test — real Postgres + RLS. The metered-usage ledger (#128 / ADR-082): durable,
// IDEMPOTENT accounting (a source_id counts once — at-least-once outbox / retry safe) that is
// RLS-scoped (one tenant never sees or affects another's usage). Verified with real writes/reads, not
// counts of rows, and with a SECOND tenant for the isolation boundary (the project design notes: tenant isolation
// is security-critical → must be tested).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { recordUsage, getUsage } from '../usage.js'
import type { Tenant } from '@wikistead/types'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'free', isolation: 'logical' }) as Tenant
const DEV = 'tenant_dev'
const OTHER = 'tenant_acme'
const P = '2026-07-01' // billing-window anchor under test
const R = 'test.metric' // isolated resource id so cleanup never touches real usage

let dev: TenantDb
let other: TenantDb

beforeAll(async () => {
  await admin`DELETE FROM usage_counters WHERE resource LIKE 'test.%'` // clean slate
  dev = await acquireTenantDb(asTenant(DEV))
  other = await acquireTenantDb(asTenant(OTHER))
}, 30_000)
afterAll(async () => {
  await admin`DELETE FROM usage_counters WHERE resource LIKE 'test.%'`.catch(() => {})
  await dev.release()
  await other.release()
  await admin.end()
  await pool.end()
}, 30_000)

describe('usage ledger (#128 / ADR-082)', () => {
  it('records an increment and reads it back', async () => {
    expect(await recordUsage(dev, R, P, 'src-a', 30)).toBe(true)
    expect(await getUsage(dev, R, P)).toBe(30)
  })

  it('is IDEMPOTENT by source_id — a retried increment counts ONCE (no double-count)', async () => {
    expect(await recordUsage(dev, R, P, 'src-a', 30)).toBe(false) // same source → no new row
    expect(await recordUsage(dev, R, P, 'src-a', 999)).toBe(false) // even a different amount: still no-op
    expect(await getUsage(dev, R, P)).toBe(30) // unchanged — counted exactly once
  })

  it('accumulates distinct sources (SUM)', async () => {
    expect(await recordUsage(dev, R, P, 'src-b', 12)).toBe(true)
    expect(await getUsage(dev, R, P)).toBe(42) // 30 + 12
  })

  it('separates billing windows (period_start) and resources', async () => {
    await recordUsage(dev, R, '2026-08-01', 'src-c', 7) // a different period
    await recordUsage(dev, 'test.other', P, 'src-d', 5) // a different resource
    expect(await getUsage(dev, R, P)).toBe(42) // unaffected by the other period/resource
    expect(await getUsage(dev, R, '2026-08-01')).toBe(7)
    expect(await getUsage(dev, 'test.other', P)).toBe(5)
  })

  it('is RLS-isolated: another tenant neither sees nor is affected by this usage', async () => {
    // `dev` has recorded 42 for (R, P). A second tenant's read must be 0 — RLS hides dev's rows.
    expect(await getUsage(other, R, P)).toBe(0)
    // And the same source_id is independent per tenant (PK is (tenant_id, resource, source_id)):
    // `other` recording 'src-a' is a genuinely new row for ITS tenant, not blocked by dev's 'src-a'.
    expect(await recordUsage(other, R, P, 'src-a', 4)).toBe(true)
    expect(await getUsage(other, R, P)).toBe(4) // only its own
    expect(await getUsage(dev, R, P)).toBe(42) // dev's total still untouched by the other tenant
  })
})
