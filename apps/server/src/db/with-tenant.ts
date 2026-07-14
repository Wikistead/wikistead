import type { Sql } from 'postgres'
import type { Tenant } from '@wikistead/types'
import { pool } from './pool.js'
import { registry } from './index.js'
import { namespaceSchema } from './namespace.js'

// #382: the ONE isolation-aware transaction helper for NON-REQUEST contexts (outbox drains, the search
// doc-builder, share-link token exchange, provisioning, anonymous public reads…). Request paths keep
// using `req.db` (the acquireTenantDb driver); everything else used to hand-write
// `pool.begin(set_config('app.tenant_id'))` — a logical-RLS assumption hardcoded ~10× that silently
// breaks a namespace-promoted tenant (public.* reads → zero rows → e.g. the doc-builder DELETES the
// tenant's search docs). This helper is the driver-layer owner of that dispatch: features stay
// isolation-blind (the the project design notes invariant tenant-db.ts declares).
//
// Behaviour for a LOGICAL tenant is byte-identical to the old hand-written sites: one pool.begin with
// app.tenant_id SET LOCAL. A NAMESPACE tenant additionally gets its search_path (RLS stays on inside
// the schema — defense-in-depth, mirroring acquireNamespace).
export async function withTenantTx<T>(tenantOrId: Tenant | string, fn: (sql: Sql) => Promise<T>): Promise<T> {
  const tenant = typeof tenantOrId === 'string' ? await registry.findById(tenantOrId) : tenantOrId
  if (!tenant) throw new Error(`withTenantTx: unknown tenant ${JSON.stringify(tenantOrId)}`)
  switch (tenant.isolation) {
    case 'logical':
      return pool.begin(async (tx) => {
        await tx`SELECT set_config('app.tenant_id', ${tenant.id}, true)`
        return fn(tx as unknown as Sql)
      }) as Promise<T>
    case 'namespace': {
      const searchPath = `${namespaceSchema(tenant.id)}, public`
      return pool.begin(async (tx) => {
        await tx`SELECT set_config('search_path', ${searchPath}, true)`
        await tx`SELECT set_config('app.tenant_id', ${tenant.id}, true)`
        return fn(tx as unknown as Sql)
      }) as Promise<T>
    }
    default:
      throw new Error(`unsupported isolation strategy: ${(tenant as Tenant).isolation}`)
  }
}
