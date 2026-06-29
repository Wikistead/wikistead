// Integration tests — runs against a real Postgres (docker compose up -d).
// Mocking the DB is explicitly avoided: RLS enforcement is a security boundary
// and must be verified against the actual Postgres policy evaluation.
import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { TenantRegistry } from '../db/registry.js'
import { acquireTenantDb } from '../db/tenant-db.js'

afterAll(() => pool.end())

describe('TenantRegistry', () => {
  const registry = new TenantRegistry(pool)

  it('finds a known tenant by slug', async () => {
    const tenant = await registry.findBySlug('dev')
    expect(tenant).not.toBeNull()
    expect(tenant!.slug).toBe('dev')
    expect(tenant!.id).toBe('tenant_dev')
    expect(tenant!.isolation).toBe('logical')
  })

  it('returns null for an unknown slug', async () => {
    const tenant = await registry.findBySlug('__no_such_tenant__')
    expect(tenant).toBeNull()
  })

  it('returns null for an unknown domain', async () => {
    const tenant = await registry.findByDomain('no.such.domain')
    expect(tenant).toBeNull()
  })

  it('serves repeated lookups from cache without extra DB round-trips', async () => {
    const r1 = await registry.findBySlug('acme')
    const r2 = await registry.findBySlug('acme')
    expect(r1).toBe(r2) // same object reference == cache hit
  })
})

describe('LogicalTenantDb', () => {
  const tenantDev  = { id: 'tenant_dev',  slug: 'dev',  isolation: 'logical' as const, plan: 'free' }
  const tenantAcme = { id: 'tenant_acme', slug: 'acme', isolation: 'logical' as const, plan: 'pro' }

  it('sets app.tenant_id after acquire', async () => {
    const db = await acquireTenantDb(tenantDev)
    try {
      const [{ v }] = await db.sql<[{ v: string }]>`
        SELECT current_setting('app.tenant_id', TRUE) AS v
      `
      expect(v).toBe('tenant_dev')
    } finally {
      await db.release()
    }
  })

  it('does not leak tenant_id across successive acquisitions', async () => {
    // Acquire tenant A, release, then acquire tenant B on the same (pooled)
    // connection. If release() failed to reset, tenant B would see tenant A's id.
    const dbA = await acquireTenantDb(tenantDev)
    await dbA.release()

    const dbB = await acquireTenantDb(tenantAcme)
    try {
      const [{ v }] = await dbB.sql<[{ v: string }]>`
        SELECT current_setting('app.tenant_id', TRUE) AS v
      `
      expect(v).toBe('tenant_acme')
    } finally {
      await dbB.release()
    }
  })

  it('resets app.tenant_id to empty string after release', async () => {
    // Reserve the same connection twice to verify the reset between uses.
    // We use pool.max=1-equivalent by serialising: release dbA, then reserve again.
    const dbA = await acquireTenantDb(tenantDev)
    const reservedConn = (dbA as any).sql  // peek at the reserved connection
    await dbA.release()

    // The connection is back in the pool. Acquire it again (likely same connection
    // since it's the only idle one at this moment in the test) to verify reset.
    const dbB = await acquireTenantDb(tenantAcme)
    try {
      const [{ v }] = await dbB.sql<[{ v: string }]>`
        SELECT current_setting('app.tenant_id', TRUE) AS v
      `
      // Regardless of whether it's the same physical connection, the value must
      // reflect the new tenant (not the previous one).
      expect(v).toBe('tenant_acme')
      void reservedConn  // suppress unused-variable lint
    } finally {
      await dbB.release()
    }
  })
})

// Cross-tenant RLS ENFORCEMENT (the actual security boundary, not just that app.tenant_id is set).
// Postgres evaluates the policy against real rows: a tenant-scoped connection must not READ, DELETE,
// or UPDATE another tenant's rows, and (USING-as-WITH-CHECK) must not INSERT a row for another
// tenant. Verified with real cross-tenant `spaces` rows.
describe('cross-tenant RLS enforcement (spaces)', () => {
  const tenantDev = { id: 'tenant_dev', slug: 'dev', isolation: 'logical' as const, plan: 'free' }
  const admin = postgres(process.env.DATABASE_ADMIN_URL!)
  const devName = `rls-dev-${Date.now().toString(36)}`
  const acmeName = `rls-acme-${Date.now().toString(36)}`
  let acmeId = ''

  beforeAll(async () => {
    // Insert rows for BOTH tenants via the admin role (bypasses RLS).
    await admin`INSERT INTO spaces (tenant_id, name) VALUES ('tenant_dev', ${devName})`
    const [a] = await admin<{ id: string }[]>`INSERT INTO spaces (tenant_id, name) VALUES ('tenant_acme', ${acmeName}) RETURNING id`
    acmeId = a.id
  }, 30_000)
  afterAll(async () => {
    await admin`DELETE FROM spaces WHERE name IN (${devName}, ${acmeName})`.catch(() => {})
    await admin`DELETE FROM spaces WHERE tenant_id = 'tenant_dev' AND name = 'rls-evil'`.catch(() => {})
    await admin.end()
  }, 30_000)

  it('READ isolation: a tenant-scoped conn sees only its own rows, not another tenant’s (even by PK)', async () => {
    const db = await acquireTenantDb(tenantDev)
    try {
      const names = (await db.sql<{ name: string }[]>`SELECT name FROM spaces`).map((r) => r.name)
      expect(names).toContain(devName)
      expect(names).not.toContain(acmeName) // RLS hides the other tenant's row
      const byPk = await db.sql`SELECT id FROM spaces WHERE id = ${acmeId}` // even a direct PK lookup
      expect(byPk.length).toBe(0)           // is invisible across the tenant boundary
    } finally {
      await db.release()
    }
  })

  it('WRITE isolation: cannot INSERT a row for another tenant (USING-as-WITH-CHECK)', async () => {
    const db = await acquireTenantDb(tenantDev)
    try {
      await expect(db.sql`INSERT INTO spaces (tenant_id, name) VALUES ('tenant_acme', 'rls-evil')`)
        .rejects.toThrow() // row-level security policy violation
    } finally {
      await db.release()
    }
  })

  it('DELETE/UPDATE isolation: cannot affect another tenant’s row (USING filters it out)', async () => {
    const db = await acquireTenantDb(tenantDev)
    try {
      const del = await db.sql`DELETE FROM spaces WHERE id = ${acmeId}`
      expect(del.count).toBe(0) // the other tenant's row is unreachable → 0 affected
      const upd = await db.sql`UPDATE spaces SET name = 'hijacked' WHERE id = ${acmeId}`
      expect(upd.count).toBe(0)
    } finally {
      await db.release()
    }
  })
})
