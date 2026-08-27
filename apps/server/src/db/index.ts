export { pool } from './pool.js'
export { withTenantTx } from './with-tenant.js' // #382: the isolation-aware tx for non-request contexts
export { acquireTenantDb } from './tenant-db.js'
export type { TenantDb } from './tenant-db.js'
export { TenantRegistry, listActiveTenantIds } from './registry.js'

import { pool } from './pool.js'
import { TenantRegistry } from './registry.js'

// Singleton registry shared across requests. Uses the runtime pool (no RLS
// needed — tenants table has no RLS policy; it's the global registry).
export const registry = new TenantRegistry(pool)
