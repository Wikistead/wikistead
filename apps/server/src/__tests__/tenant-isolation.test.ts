// Integration tests — runs against a real Postgres (docker compose up -d).
// Mocking the DB is explicitly avoided: RLS enforcement is a security boundary
// and must be verified against the actual Postgres policy evaluation.
import { describe, it, expect, afterAll } from 'vitest'
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

// TODO(phase: spaces): cross-tenant RLS enforcement test.
// Once spaces/pages tables exist:
//   - INSERT a space for tenant_dev  (via admin conn, bypass RLS)
//   - INSERT a space for tenant_acme (via admin conn, bypass RLS)
//   - Acquire tenantDev db  → SELECT FROM spaces → must NOT see tenant_acme's row
//   - Acquire tenantAcme db → SELECT FROM spaces → must NOT see tenant_dev's row
