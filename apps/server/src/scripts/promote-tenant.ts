// Operator-initiated tenant promotion logical → namespace (ADR-047 / #117): `pnpm tenant:promote <slug|id>`.
//
// ADR-047's chosen v1 trigger is an explicit operator action (no automatic data-volume / plan
// triggers yet — those are a later ops decision; the mechanism here supports whatever policy drives
// it). Promotion is NON-DESTRUCTIVE (public rows kept for rollback) and idempotent. This moves only
// DB rows; storage (S3 `{tenantId}/…`) and search (shared index + tenantId filter) stay keyed by
// tenantId, so nothing else moves. A zero-downtime LIVE cutover is the deferred ADR-047 §3 sub-ADR —
// run this during a maintenance window until that lands.
import postgres from 'postgres'
import type { Tenant, TenantIsolation } from '@wikistead/types'
import { promoteTenantToNamespace } from '../db/namespace.js'

// Resolve a tenant row by slug OR id (operator convenience — a human passes whichever they have).
async function loadTenantForPromotion(sql: postgres.Sql, key: string): Promise<Tenant | null> {
  const rows = await sql<{ id: string; slug: string; custom_domain: string | null; isolation: string; plan: string }[]>`
    SELECT id, slug, custom_domain, isolation, plan FROM tenants WHERE slug = ${key} OR id = ${key} LIMIT 1`
  const r = rows[0]
  if (!r) return null
  return {
    id: r.id,
    slug: r.slug,
    customDomain: r.custom_domain ?? undefined,
    isolation: r.isolation as TenantIsolation,
    plan: r.plan,
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const key = process.argv[2]
  if (!key) { console.error('usage: pnpm tenant:promote <slug|id>'); process.exit(1) }
  const admin = postgres(process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL!)
  try {
    const tenant = await loadTenantForPromotion(admin, key)
    if (!tenant) { console.error(`tenant not found: ${key}`); process.exit(1) }
    if (tenant.isolation === 'namespace') { console.log(`tenant ${tenant.slug} (${tenant.id}) is already namespace-isolated`); process.exit(0) }
    console.log(`promoting tenant ${tenant.slug} (${tenant.id}) → namespace …`)
    await promoteTenantToNamespace(tenant, admin)
    console.log(`done. rows copied into a dedicated schema (public rows kept for rollback); isolation flipped to namespace.`)
  } finally {
    await admin.end()
  }
}
