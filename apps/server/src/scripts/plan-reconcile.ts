// Reconciling plan-downgrade commit batch (#131 / ADR-064): `pnpm plan:reconcile`.
//
// A downgrade webhook defers (keeps the old plan, records pending_plan + pending_plan_at). This
// batch commits the downgrades whose grace has elapsed: plan := pending_plan, then clears the
// pending fields. Reconciling + idempotent — it recomputes from the tenant rows each run, so a
// missed/late run self-heals (no reliance on a single timer); a committed downgrade has no
// pending fields, so a re-run skips it (no double-commit). After the commit the tenant's reduced
// entitlements apply to NEW operations through the normal resolver (seat/storage/branding/api
// gates); the existing-overage freeze (deactivation) is a separate enforcement step (ADR-064).
import postgres from 'postgres'
import { emit } from '@wikistead/events'
import { PLAN_DOWNGRADE_GRACE_S } from '../plan.js'

export async function reconcilePlans(
  sql: postgres.Sql,
  opts: { graceSeconds?: number } = {},
): Promise<{ committed: number }> {
  const grace = opts.graceSeconds ?? PLAN_DOWNGRADE_GRACE_S
  const due = await sql<{ id: string; plan: string; pending_plan: string }[]>`
    SELECT id, plan, pending_plan FROM tenants
    WHERE pending_plan IS NOT NULL
      AND pending_plan_at + make_interval(secs => ${grace}) <= now()
  `
  let committed = 0
  for (const t of due) {
    // The `pending_plan = ...` guard avoids racing a concurrent upgrade that cleared pending.
    const res = await sql`
      UPDATE tenants SET plan = ${t.pending_plan}, pending_plan = NULL, pending_plan_at = NULL
      WHERE id = ${t.id} AND pending_plan = ${t.pending_plan}
    `
    if (res.count > 0) {
      emit({ type: 'tenant.plan_changed', tenantId: t.id, oldPlan: t.plan, newPlan: t.pending_plan })
      committed++
    }
  }
  return { committed }
}

// CLI entry: run only when invoked directly (not when imported by a test).
if (import.meta.url === `file://${process.argv[1]}`) {
  const adminPool = postgres(process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL!)
  try {
    const { committed } = await reconcilePlans(adminPool)
    console.log(`plan:reconcile — committed ${committed} elapsed downgrade(s)`)
  } finally {
    await adminPool.end()
  }
}
