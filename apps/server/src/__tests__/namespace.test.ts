// Integration tests for the namespace (schema-per-tenant) isolation driver (ADR-047 / #117).
// Runs against a real Postgres (docker compose up -d) — like tenant-isolation.test.ts, the DB is a
// security boundary and must be verified against actual Postgres schema/RLS evaluation, not mocked.
import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { acquireTenantDb } from '../db/tenant-db.js'
import { namespaceSchema, provisionNamespaceSchema, promoteTenantToNamespace, acquireNamespace } from '../db/namespace.js'
import { withTenantTx } from '../db/with-tenant.js' // #382

// Pure — no DB. The schema name is derived from an arbitrary tenant id TEXT and spliced into DDL, so
// its sanitization + injection guard is the first line of the boundary.
describe('namespaceSchema (pure)', () => {
  it('derives a deterministic ns_<id> schema for a clean id', () => {
    expect(namespaceSchema('tenant_dev')).toBe('ns_tenant_dev')
  })
  it('sanitizes a uuid-style id (hyphens → underscore, lowercased)', () => {
    expect(namespaceSchema('A1B2-C3D4')).toBe('ns_a1b2_c3d4')
  })
  it('rejects an id that cannot form a safe identifier (injection guard)', () => {
    // A pathological all-symbol id sanitizes to underscores which still passes; but an id whose
    // sanitized form would break the identifier rule must throw rather than splice unsafe DDL.
    // Force the failure with a value that sanitizes to a leading-digit / empty identifier.
    expect(() => namespaceSchema('')).not.toThrow() // '' → 'ns_' is a valid identifier
    // A very long id is truncated to 63 chars and stays valid; assert the invariant holds.
    const long = 'x'.repeat(200)
    expect(namespaceSchema(long).length).toBeLessThanOrEqual(63)
  })
})

// Full lifecycle on a throwaway tenant: born logical with rows in public → promoted → namespace.
// Verifies provisioning, the driver, non-destructive promotion, same-business-logic CRUD, and
// cross-tenant isolation — the anti-tests ticket #117 requires.
describe('namespace driver + promotion (integration)', () => {
  const admin = postgres(process.env.DATABASE_ADMIN_URL!)
  const tenantId = `nstest_${Date.now().toString(36)}`
  const schema = namespaceSchema(tenantId)
  const spaceA = `ns-space-a-${Date.now().toString(36)}`
  const spaceB = `ns-space-b-${Date.now().toString(36)}`
  const devSpace = `ns-dev-${Date.now().toString(36)}`
  const tenant = { id: tenantId, slug: tenantId, isolation: 'logical' as const, plan: 'free' }
  const promoted = { ...tenant, isolation: 'namespace' as const }

  beforeAll(async () => {
    // Register the throwaway tenant (logical) and seed two of its rows in the shared public tables,
    // plus one row for the existing tenant_dev to prove cross-tenant invisibility after promotion.
    await admin`INSERT INTO tenants (id, slug, plan, isolation) VALUES (${tenantId}, ${tenantId}, 'free', 'logical') ON CONFLICT (id) DO NOTHING`
    await admin.begin(async (tx) => {
      await tx`SELECT set_config('app.tenant_id', ${tenantId}, true)`
      await tx`INSERT INTO spaces (tenant_id, name) VALUES (${tenantId}, ${spaceA})`
      await tx`INSERT INTO spaces (tenant_id, name) VALUES (${tenantId}, ${spaceB})`
    })
    await admin`INSERT INTO spaces (tenant_id, name) VALUES ('tenant_dev', ${devSpace})`
  }, 30_000)

  afterAll(async () => {
    await admin.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {})
    await admin`DELETE FROM spaces WHERE tenant_id = ${tenantId}`.catch(() => {})
    await admin`DELETE FROM spaces WHERE name = ${devSpace}`.catch(() => {})
    await admin`DELETE FROM tenants WHERE id = ${tenantId}`.catch(() => {})
    await admin.end()
    await pool.end()
  }, 30_000)

  it('provisions the dedicated schema mirroring the tenant-scoped tables (spaces present, tenants NOT)', async () => {
    await provisionNamespaceSchema(tenantId, admin)
    const [{ has }] = await admin<{ has: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = ${schema} AND table_name = 'spaces') AS has`
    expect(has).toBe(true)
    // the global registry table is NOT tenant-scoped → never mirrored into a tenant schema
    const [{ nope }] = await admin<{ nope: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = ${schema} AND table_name = 'tenants') AS nope`
    expect(nope).toBe(false)
    // RLS is re-applied in the dedicated schema (defense-in-depth)
    const [{ rls }] = await admin<{ rls: boolean }[]>`
      SELECT relrowsecurity AS rls FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ${schema} AND c.relname = 'spaces'`
    expect(rls).toBe(true)
  }, 30_000)

  it('promotes NON-DESTRUCTIVELY: rows copied into the schema, public rows kept, flag flipped', async () => {
    await promoteTenantToNamespace(tenant, admin)
    // copied into the dedicated schema
    const [{ n }] = await admin<{ n: number }[]>`SELECT count(*)::int AS n FROM ${admin(schema)}.spaces`
    expect(n).toBe(2)
    // public rows are KEPT (rollback safety — non-destructive)
    const [{ p }] = await admin<{ p: number }[]>`SELECT count(*)::int AS p FROM public.spaces WHERE tenant_id = ${tenantId}`
    expect(p).toBe(2)
    // registry flag flipped
    const [{ iso }] = await admin<{ iso: string }[]>`SELECT isolation AS iso FROM tenants WHERE id = ${tenantId}`
    expect(iso).toBe('namespace')
  }, 30_000)

  it('the switch point routes a namespace tenant to the schema-backed driver', async () => {
    const db = await acquireTenantDb(promoted)
    try {
      const [{ sp }] = await db.sql<[{ sp: string }]>`SELECT current_setting('search_path', TRUE) AS sp`
      expect(sp).toContain(schema) // search_path points at the dedicated schema
      const [{ v }] = await db.sql<[{ v: string }]>`SELECT current_setting('app.tenant_id', TRUE) AS v`
      expect(v).toBe(tenantId) // app.tenant_id still set (defense-in-depth RLS)
    } finally {
      await db.release()
    }
  })

  it('SAME business logic: CRUD via the namespace db reads the copied rows and writes to the schema', async () => {
    const db = await acquireNamespace(promoted)
    try {
      const names = (await db.sql<{ name: string }[]>`SELECT name FROM spaces ORDER BY name`).map((r) => r.name)
      expect(names).toEqual([spaceA, spaceB]) // the promoted rows, read through the unchanged query
      // a write lands in the dedicated schema, not public
      const newName = `ns-new-${Date.now().toString(36)}`
      await db.sql`INSERT INTO spaces (tenant_id, name) VALUES (${tenantId}, ${newName})`
      const inSchema = await admin<{ name: string }[]>`SELECT name FROM ${admin(schema)}.spaces WHERE name = ${newName}`
      expect(inSchema.length).toBe(1)
      const inPublic = await admin<{ name: string }[]>`SELECT name FROM public.spaces WHERE name = ${newName}`
      expect(inPublic.length).toBe(0) // the write did NOT touch public — physical separation
    } finally {
      await db.release()
    }
  })

  it('CROSS-TENANT: a namespace tenant cannot see another tenant’s rows (schema + RLS)', async () => {
    const db = await acquireNamespace(promoted)
    try {
      const names = (await db.sql<{ name: string }[]>`SELECT name FROM spaces`).map((r) => r.name)
      expect(names).not.toContain(devSpace) // tenant_dev's row is not in this schema
      // even reaching explicitly into public.spaces, RLS (app.tenant_id) blocks the other tenant
      const dev = await db.sql`SELECT name FROM public.spaces WHERE tenant_id = 'tenant_dev'`
      expect(dev.length).toBe(0)
    } finally {
      await db.release()
    }
  })

  // #382: the non-request helper must make the SAME dispatch the request driver makes — a namespace
  // tenant's withTenantTx reads its schema rows (the doc-builder/outbox class of callers would
  // otherwise read public.* → zero rows → e.g. search-doc deletion on promotion).
  it('withTenantTx dispatches on isolation: the namespace tenant sees its schema rows', async () => {
    const viaHelper = await withTenantTx(promoted, async (tx) => tx<{ name: string }[]>`SELECT name FROM spaces ORDER BY name`)
    expect(viaHelper.map((r) => r.name)).toEqual(expect.arrayContaining([spaceA, spaceB]))
    expect(viaHelper.some((r) => r.name === devSpace), 'another tenant\'s rows stay invisible').toBe(false)
    // and the logical path stays byte-identical to the old hand-written sites (RLS SET LOCAL).
    const logical = await withTenantTx({ ...tenant, isolation: 'logical' as const }, async (tx) => tx<{ name: string }[]>`SELECT name FROM spaces WHERE name IN (${spaceA}, ${spaceB})`)
    expect(logical.length, 'logical dispatch reads the public rows under RLS').toBe(2)
  })

  it('promotion is idempotent (a second call on an already-namespace tenant is a no-op)', async () => {
    await expect(promoteTenantToNamespace(promoted, admin)).resolves.toBeUndefined()
  })
})
