export { pool } from './pool.js'
export { acquireTenantDb } from './tenant-db.js'
export type { TenantDb } from './tenant-db.js'
export { TenantRegistry } from './registry.js'

import { pool } from './pool.js'
import { TenantRegistry } from './registry.js'

// Singleton registry shared across requests. Uses the runtime pool (no RLS
// needed — tenants table has no RLS policy; it's the global registry).
export const registry = new TenantRegistry(pool)
