import postgres, { type Sql } from 'postgres'
import type { Tenant } from '@wikistead/types'
import { pool } from './pool.js'
import type { TenantDb } from './tenant-db.js'

// Namespace isolation driver (ADR-047 / #117): a promoted tenant gets a DEDICATED Postgres SCHEMA
// (`ns_<tenant>`) holding its own copy of every tenant-scoped table, instead of sharing the `public`
// tables with RLS. Feature code is unchanged (ADR-001): it still talks to `TenantDb.sql`; only the
// `search_path` differs, so unqualified `spaces` resolves to `ns_x.spaces`. RLS (app.tenant_id) is
// KEPT ON inside the dedicated schema as defense-in-depth — a namespace tenant is *more* isolated,
// never less. Storage (S3 `{tenantId}/…` prefix) and search (shared index + `tenantId` filter) stay
// keyed by tenantId — still isolated; a per-tenant bucket/index is a later, separate increment and
// nothing moves on promotion (only DB rows do). Zero-downtime LIVE cutover is a deferred sub-ADR
// (ADR-047 §3); this promotion is operator-initiated and non-destructive (public rows are kept).

// A Postgres identifier must be a safe token; both the schema name (derived from an arbitrary tenant
// id TEXT) and any table name we splice into DDL are validated before use — injection guard.
const IDENT_RE = /^[a-z_][a-z0-9_]*$/
function assertIdent(name: string, what: string): string {
  if (!IDENT_RE.test(name) || name.length > 63) throw new Error(`unsafe ${what} identifier: ${JSON.stringify(name)}`)
  return name
}

// The dedicated schema name for a tenant. Deterministic + injection-safe: lowercase the id, map any
// non-identifier char to '_', prefix `ns_`, and re-validate (a bare uuid/`tenant_x` id maps cleanly).
export function namespaceSchema(tenantId: string): string {
  const sanitized = tenantId.toLowerCase().replace(/[^a-z0-9_]/g, '_')
  return assertIdent(`ns_${sanitized}`.slice(0, 63), 'namespace schema')
}

// Acquire a TenantDb backed by the tenant's dedicated schema. Mirrors acquireLogical (tenant-db.ts):
// same interface, same reserved-connection lifecycle — the ONLY difference is search_path points at
// the schema. app.tenant_id is still set (defense-in-depth: the FORCE RLS policies re-created in the
// schema keep cross-tenant reads impossible even if a query reached a public.* table).
export async function acquireNamespace(tenant: Tenant): Promise<TenantDb> {
  const schema = namespaceSchema(tenant.id)
  const searchPath = `${schema}, public`
  const reserved = await pool.reserve()
  await reserved`SELECT set_config('search_path', ${searchPath}, false)`
  await reserved`SELECT set_config('app.tenant_id', ${tenant.id}, false)`
  return {
    sql: reserved as unknown as Sql,
    tx<T>(fn: (sql: Sql) => Promise<T>): Promise<T> {
      return pool.begin(async (txSql) => {
        await txSql`SELECT set_config('search_path', ${searchPath}, true)`
        await txSql`SELECT set_config('app.tenant_id', ${tenant.id}, true)`
        return fn(txSql as unknown as Sql)
      }) as Promise<T>
    },
    async release() {
      try {
        await reserved`SELECT set_config('search_path', 'public', false)`
        await reserved`SELECT set_config('app.tenant_id', '', false)`
      } finally {
        reserved.release()
      }
    },
  }
}

// A fresh admin connection for DDL (CREATE SCHEMA / TABLE, cross-schema copy) — the runtime `app`
// role intentionally lacks those privileges (same rationale as migrate.ts). Callers that own the
// connection must end() it; tests can inject their own Sql to share a connection.
function adminConnection(): Sql {
  const url = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_ADMIN_URL or DATABASE_URL required for namespace provisioning')
  return postgres(url, { max: 1, onnotice: () => {} })
}

// The tenant-scoped tables = every public table carrying the `tenant_isolation` RLS policy (the
// convention from 001_tenants.sql). Deriving the set from the live catalog avoids a hand-maintained
// list drifting from the migrations, and naturally excludes the global registry tables (tenants,
// schema_migrations) which have no such policy.
async function tenantScopedTables(sql: Sql): Promise<string[]> {
  const rows = await sql<{ tablename: string }[]>`
    SELECT DISTINCT tablename FROM pg_policies
    WHERE schemaname = 'public' AND policyname = 'tenant_isolation'
    ORDER BY tablename`
  return rows.map((r) => assertIdent(r.tablename, 'tenant table'))
}

// Create the dedicated schema and mirror the STRUCTURE of every tenant-scoped table into it
// (LIKE INCLUDING ALL = columns, defaults, checks, PK/unique, indexes — but NOT foreign keys, so no
// cross-schema FK, and NOT RLS, which we re-apply below for defense-in-depth). Idempotent. DDL only;
// no data is copied here (see promoteTenantToNamespace).
export async function provisionNamespaceSchema(tenantId: string, admin: Sql): Promise<void> {
  const schema = namespaceSchema(tenantId)
  const tables = await tenantScopedTables(admin)
  await admin.begin(async (tx) => {
    await tx.unsafe(`CREATE SCHEMA IF NOT EXISTS ${schema}`)
    await tx.unsafe(`GRANT USAGE ON SCHEMA ${schema} TO app`)
    for (const t of tables) {
      await tx.unsafe(`CREATE TABLE IF NOT EXISTS ${schema}.${t} (LIKE public.${t} INCLUDING ALL)`)
      // Re-apply RLS in the dedicated schema (LIKE does not copy policies). Redundant given schema
      // isolation, but kept so a namespace tenant is never LESS protected than a logical one.
      await tx.unsafe(`ALTER TABLE ${schema}.${t} ENABLE ROW LEVEL SECURITY`)
      await tx.unsafe(`ALTER TABLE ${schema}.${t} FORCE ROW LEVEL SECURITY`)
      await tx.unsafe(`DROP POLICY IF EXISTS tenant_isolation ON ${schema}.${t}`)
      await tx.unsafe(`CREATE POLICY tenant_isolation ON ${schema}.${t} USING (tenant_id = current_setting('app.tenant_id', TRUE))`)
      await tx.unsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ${schema}.${t} TO app`)
    }
  })
}

// Promote a tenant logical → namespace (operator-initiated). NON-DESTRUCTIVE: provisions the schema,
// COPIES this tenant's rows public → schema, and flips the registry flag in ONE transaction so a
// failure leaves the tenant logical. The public rows are intentionally KEPT (rollback safety); a
// later GC removes them once the promotion is confirmed. This is a cold copy — a zero-downtime live
// cutover (no lost writes during migration) is the deferred ADR-047 §3 sub-ADR.
export async function promoteTenantToNamespace(tenant: Tenant, injectedAdmin?: Sql): Promise<void> {
  if (tenant.isolation === 'namespace') return // idempotent — already promoted
  const admin = injectedAdmin ?? adminConnection()
  const ownsConnection = injectedAdmin == null
  try {
    const schema = namespaceSchema(tenant.id)
    await provisionNamespaceSchema(tenant.id, admin)
    const tables = await tenantScopedTables(admin)
    await admin.begin(async (tx) => {
      // Scope the admin session to this tenant so the copy respects RLS even if the admin role does
      // not bypass it (defense-in-depth), and so FORCE RLS on the destination accepts the inserts.
      await tx`SELECT set_config('app.tenant_id', ${tenant.id}, true)`
      for (const t of tables) {
        await tx.unsafe(
          `INSERT INTO ${schema}.${t} SELECT * FROM public.${t} WHERE tenant_id = $1 ON CONFLICT DO NOTHING`,
          [tenant.id],
        )
      }
      await tx`UPDATE tenants SET isolation = 'namespace' WHERE id = ${tenant.id}`
    })
  } finally {
    if (ownsConnection) await admin.end()
  }
}
