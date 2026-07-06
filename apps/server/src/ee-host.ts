// #178 / ADR-084: the CE "EE host" surface — the ONE public barrel the physically-separated EE
// packages (@wikistead-ee/*) import from `@wikistead/server/ee-host`. EE→CE is a permitted one-way
// dependency (the open-core guard forbids only CE→EE; ee-server is proprietary so it is exempt from
// the CE-library rule). Keeping the surface here — rather than letting EE reach into arbitrary deep
// paths — makes the boundary auditable: this file is exactly what EE may use from the CE app.
//
// It re-exports (a) the bootstrap the EE composition root calls (startServer / buildApp), and (b) the
// app-layer helpers the moved SCIM code needs (tenant resolution, tenant-db, seat/group/audit
// helpers, the pg pool, entitlement-UX). Adding to this list is the deliberate act of widening the
// EE↔CE contract.

export { startServer } from './server.js'
export { buildApp } from './app.js'

export { pool } from './db/pool.js'
export { acquireTenantDb } from './db/index.js'
export type { TenantDb } from './db/index.js'

export { resolveTenantFromHost, loadTenant } from './tenant.js'
export { groupFgaId, syncMemberGroups } from './auth/group-sync.js'
export { billableMemberCount, lockSeats } from './auth/invites.js'
export { auditIfEntitled, drainAuditOutbox, verifyTenantAuditChain } from './audit/outbox.js'
export { entitlementDenied } from './entitlement-ux.js'
