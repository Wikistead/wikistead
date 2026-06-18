import type { Sql } from 'postgres'
import type { Tenant } from '@kb/types'
import { pool } from './pool.js'

// The only DB interface features ever see. Isolation strategy is invisible here.
export interface TenantDb {
  // postgres.js tagged-template Sql scoped to this tenant's connection.
  // RLS (app.tenant_id) is active for every query on this handle.
  readonly sql: Sql
  // Reset app.tenant_id and return the connection to the pool.
  release(): Promise<void>
}

export async function acquireTenantDb(tenant: Tenant): Promise<TenantDb> {
  switch (tenant.isolation) {
    case 'logical':
      return acquireLogical(tenant)
    // TODO(phase: tenancy-namespace): case 'namespace': return acquireNamespace(tenant)
    default:
      throw new Error(`unsupported isolation strategy: ${tenant.isolation}`)
  }
}

async function acquireLogical(tenant: Tenant): Promise<TenantDb> {
  const reserved = await pool.reserve()
  // Session-level: holds for the lifetime of this reserved connection.
  // Cleared in release() before returning the connection to the pool.
  await reserved`SELECT set_config('app.tenant_id', ${tenant.id}, false)`
  return {
    sql: reserved as unknown as Sql,
    async release() {
      try {
        await reserved`SELECT set_config('app.tenant_id', '', false)`
      } finally {
        reserved.release()
      }
    },
  }
}
