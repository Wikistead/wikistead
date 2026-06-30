import type { TenantDb } from './db/index.js'

// The billing-window anchor for `now` — the first day of its month, 'YYYY-MM-01' (UTC). All
// increments/reads in a month share this period_start. Injectable `now` for tests. The exact anchor
// (monthly) is a billing detail (ADR-004) that can change here without touching callers.
export function currentPeriodStart(now: Date = new Date()): string {
  const y = now.getUTCFullYear()
  const m = String(now.getUTCMonth() + 1).padStart(2, '0')
  return `${y}-${m}-01`
}

// Rough token estimate when a provider does not report its own usage (#128). ~4 chars/token is the
// usual heuristic; deliberately a slight OVER-estimate (ceil) so metering never silently under-counts
// a billable call. Used only as a fallback — a provider's reported token count is authoritative.
export function estimateTokens(...parts: Array<string | undefined>): number {
  const chars = parts.reduce((n, p) => n + (p ? p.length : 0), 0)
  return Math.max(1, Math.ceil(chars / 4))
}

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

// Claim a usage-alert for (resource, period, threshold) — returns true iff THIS call is the first to
// record it (so the caller emits exactly once). Durable + concurrency-safe (the PK makes a second
// writer a no-op), closing the concurrent-double-alert gap that crossedThresholds alone can't (two
// requests reading the same pre-usage). RLS-scoped via the caller's tenant.
export async function recordThresholdAlert(
  db: TenantDb,
  resource: string,
  periodStart: string,
  threshold: number,
): Promise<boolean> {
  const rows = await db.sql<{ claimed: boolean }[]>`
    INSERT INTO usage_alerts (tenant_id, resource, period_start, threshold)
    VALUES (current_setting('app.tenant_id', TRUE), ${resource}, ${periodStart}, ${threshold})
    ON CONFLICT (tenant_id, resource, period_start, threshold) DO NOTHING
    RETURNING TRUE AS claimed
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
