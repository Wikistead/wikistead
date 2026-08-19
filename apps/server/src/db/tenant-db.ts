import type { Sql } from 'postgres'
import type { Tenant } from '@wikistead/types'
import { pool, reserveTracked } from './pool.js'
import { acquireNamespace } from './namespace.js'

// The only DB interface features ever see. Isolation strategy is invisible here.
export interface TenantDb {
  // postgres.js tagged-template Sql scoped to this tenant's connection.
  // RLS (app.tenant_id) is active for every query on this handle.
  readonly sql: Sql
  // Run fn inside a transaction with app.tenant_id SET LOCAL (auto-resets on end).
  // Use when a write must be atomic with an external side effect (e.g., FGA).
  // If fn throws, postgres.js rolls back the transaction automatically.
  tx<T>(fn: (sql: Sql) => Promise<T>): Promise<T>
  // Reset app.tenant_id and return the connection to the pool.
  release(): Promise<void>
}

export async function acquireTenantDb(tenant: Tenant): Promise<TenantDb> {
  switch (tenant.isolation) {
    case 'logical':
      return acquireLogical(tenant)
    case 'namespace':
      return acquireNamespace(tenant) // ADR-047 / #117: dedicated schema per promoted tenant
    default:
      throw new Error(`unsupported isolation strategy: ${tenant.isolation}`)
  }
}

async function acquireLogical(tenant: Tenant): Promise<TenantDb> {
  // #773: reserveTracked, not pool.reserve — the pool must not be ended while this handle is on
  // its way back. See pool.ts.
  const reserved = await reserveTracked()
  // Session-level: holds for the lifetime of this reserved connection.
  // Cleared in release() before returning the connection to the pool.
  await reserved`SELECT set_config('app.tenant_id', ${tenant.id}, false)`
  return {
    sql: reserved as unknown as Sql,
    // tx() uses a separate pool connection with SET LOCAL so the transaction
    // connection is independent of the reserved connection. SET LOCAL means
    // the tenant_id resets automatically at transaction end — safer than SESSION.
    tx<T>(fn: (sql: Sql) => Promise<T>): Promise<T> {
      return pool.begin(async (txSql) => {
        await txSql`SELECT set_config('app.tenant_id', ${tenant.id}, true)`
        return fn(txSql as unknown as Sql)
      }) as Promise<T>
    },
    async release() {
      try {
        await reserved`SELECT set_config('app.tenant_id', '', false)`
      } finally {
        reserved.release()
      }
    },
  }
}
