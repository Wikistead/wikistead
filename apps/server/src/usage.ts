import type { TenantDb } from './db/index.js'

// Metered-usage ledger accessors (#128 / ADR-082). Tenant scoping is enforced by RLS on the caller's
// TenantDb handle (app.tenant_id) — these functions never take a tenant id, so a caller structurally
// cannot read or write another tenant's usage. recordUsage is IDEMPOTENT by source_id (the originating
// operation / outbox id): a retried or at-least-once-delivered increment counts exactly once, and a
// failed / charge-less op is simply never recorded. The allowance/soft-cap DECISION lives in the
// entitlement layer (decideAllowance, @wikistead/entitlements) — this module only ACCOUNTS.

// Record a metered increment. `sourceId` is the originating operation/outbox id (the idempotency key):
// a repeat with the same (resource, sourceId) is a no-op. Returns true iff a NEW row was written
// (false = this source was already counted). `amount` is the metered quantity (requests|tokens|bytes).
export async function recordUsage(
  db: TenantDb,
  resource: string,
  periodStart: string, // 'YYYY-MM-DD' billing-window anchor
  sourceId: string,
  amount: number,
): Promise<boolean> {
  const rows = await db.sql<{ inserted: boolean }[]>`
    INSERT INTO usage_counters (tenant_id, resource, period_start, source_id, amount)
    VALUES (current_setting('app.tenant_id', TRUE), ${resource}, ${periodStart}, ${sourceId}, ${amount})
    ON CONFLICT (tenant_id, resource, source_id) DO NOTHING
    RETURNING TRUE AS inserted
  `
  return rows.length > 0
}

// Total metered usage for a resource in a billing window (SUM of recorded increments). RLS scopes the
// read to the caller's tenant; returns 0 when nothing is recorded.
export async function getUsage(db: TenantDb, resource: string, periodStart: string): Promise<number> {
  const [row] = await db.sql<{ usage: string }[]>`
    SELECT COALESCE(SUM(amount), 0)::bigint AS usage
    FROM usage_counters
    WHERE resource = ${resource} AND period_start = ${periodStart}
  `
  return Number(row?.usage ?? 0)
}
