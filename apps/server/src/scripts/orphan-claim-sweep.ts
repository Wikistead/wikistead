// Reconciling sweep for expired orphan-draft claims (#99 / ADR-061): `pnpm orphan:sweep`.
//
// A claim grants a tenant#admin a TEMPORARY `manage` grant on an orphaned draft so they can
// read it and reassign a new owner. The FGA model has no user-scoped `non_expired` condition,
// so the TTL is enforced HERE, not in a time-conditioned tuple: this sweep finds claims past
// `expires_at`, REVOKES the admin's grant, and removes the row — returning the page to orphan
// (claimable again). Idempotent (a missing grant delete is a no-op) and cross-tenant (admin
// role bypasses RLS, like storage:gc).
import postgres from 'postgres'
import { emit } from '@wikistead/events'
import { fgaClient, deleteTuples } from '@wikistead/authz'
import type { OpenFgaClient } from '@openfga/sdk'

// Revoke + clear every expired claim. `sql` MUST be an admin-role connection (bypasses RLS) so
// the sweep sees all tenants. Returns the number of claims expired.
export async function sweepExpiredClaims(sql: postgres.Sql, fga: OpenFgaClient): Promise<number> {
  const expired = await sql<{ tenant_id: string; page_id: string; admin_sub: string }[]>`
    SELECT tenant_id, page_id, admin_sub FROM orphan_claims WHERE expires_at < now()
  `
  for (const c of expired) {
    // Revoke the temporary admin grant (idempotent: a non-existent tuple delete is ignored).
    await deleteTuples(fga, [{ user: `user:${c.admin_sub}`, relation: 'manage_direct', object: `page:${c.page_id}` }]).catch(() => {}) // #218: manage is computed; the grant lives on manage_direct
    await sql`DELETE FROM orphan_claims WHERE tenant_id = ${c.tenant_id} AND page_id = ${c.page_id}`
    emit({ type: 'orphan_draft.claim_expired', tenantId: c.tenant_id, pageId: c.page_id, adminSub: c.admin_sub })
  }
  return expired.length
}

// CLI entry: run only when invoked directly (not when imported by a test).
if (import.meta.url === `file://${process.argv[1]}`) {
  const adminPool = postgres(process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL!)
  try {
    const n = await sweepExpiredClaims(adminPool, fgaClient)
    console.log(`orphan:sweep expired ${n} stale claim${n === 1 ? '' : 's'}`)
  } finally {
    await adminPool.end()
  }
}
