// Tenant-scoped DB access for the collab server.
// Uses the same restricted 'app' role as the API server so RLS and
// FORCE ROW LEVEL SECURITY apply to every query.
import postgres from 'postgres'
import type { Sql } from 'postgres'

// One pool per collab process; shared across all Hocuspocus document rooms.
export const pool = postgres(process.env.DATABASE_URL!, { max: 10, onnotice: () => {} })

// Execute fn inside a transaction with app.tenant_id SET LOCAL to tenantId.
// RLS policy "tenant_id = current_setting('app.tenant_id', TRUE)" then
// automatically scopes all reads and writes to that tenant only.
// A cross-tenant call silently returns 0 rows / 0 affected rows — the caller
// is responsible for detecting and logging the 0-row case.
export async function withTenant<T>(
  tenantId: string,
  fn: (tx: Sql) => Promise<T>,
): Promise<T> {
  return pool.begin(async (tx) => {
    await tx`SELECT set_config('app.tenant_id', ${tenantId}, true)`
    return fn(tx as unknown as Sql)
  }) as Promise<T>
}
