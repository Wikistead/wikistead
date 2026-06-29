// Plan-downgrade grace (#131 / ADR-064). Unit-tests the pure effective-plan helpers + the
// reconciling commit batch (defer within grace, commit once elapsed, idempotent, no data loss).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { planRank, isDowngrade, effectivePlan } from '../plan.js'
import { reconcilePlans } from '../scripts/plan-reconcile.js'

describe('plan helpers (#131 / ADR-064)', () => {
  it('planRank / isDowngrade order free < pro < team', () => {
    expect(planRank('free')).toBeLessThan(planRank('pro'))
    expect(planRank('pro')).toBeLessThan(planRank('team'))
    expect(isDowngrade('pro', 'free')).toBe(true)
    expect(isDowngrade('free', 'pro')).toBe(false) // upgrade
    expect(isDowngrade('pro', 'pro')).toBe(false)  // same
    expect(planRank('mystery')).toBe(0)            // unknown ranks lowest (conservative)
  })

  it('effectivePlan: no pending → plan; within grace → OLD; past grace → NEW (safe-side)', () => {
    const at = new Date(1_000_000_000_000)
    expect(effectivePlan({ plan: 'pro', pendingPlan: null, pendingPlanAt: null })).toBe('pro')
    // within grace → keep the old (paid) plan
    expect(effectivePlan({ plan: 'pro', pendingPlan: 'free', pendingPlanAt: at, graceSeconds: 100, now: at.getTime() + 50_000 })).toBe('pro')
    // past grace → the new (lower) plan, even before the batch commits
    expect(effectivePlan({ plan: 'pro', pendingPlan: 'free', pendingPlanAt: at, graceSeconds: 100, now: at.getTime() + 200_000 })).toBe('free')
  })
})

describe('reconcilePlans batch (#131 / ADR-064)', () => {
  const admin = postgres(process.env.DATABASE_ADMIN_URL!)
  const TENANT = 'tenant_dev'
  let savedPlan = 'free'

  beforeAll(async () => {
    const [t] = await admin<{ plan: string }[]>`SELECT plan FROM tenants WHERE id = ${TENANT}`
    savedPlan = t.plan
  })
  afterAll(async () => {
    await admin`UPDATE tenants SET plan = ${savedPlan}, pending_plan = NULL, pending_plan_at = NULL WHERE id = ${TENANT}`
    await admin.end()
    await pool.end()
  })

  it('does NOT commit within grace; commits once elapsed (plan→pending, cleared); no data loss', async () => {
    await admin`UPDATE tenants SET plan = 'pro', pending_plan = 'free', pending_plan_at = now() WHERE id = ${TENANT}`

    // Huge grace → within grace → no commit; the old plan stays.
    await reconcilePlans(admin, { graceSeconds: 10 ** 9 })
    let [t] = await admin<{ plan: string; pending_plan: string | null }[]>`SELECT plan, pending_plan FROM tenants WHERE id = ${TENANT}`
    expect(t.plan).toBe('pro')
    expect(t.pending_plan).toBe('free')

    // Grace 0 → elapsed → commit: plan becomes the pending target, pending cleared.
    const r = await reconcilePlans(admin, { graceSeconds: 0 })
    expect(r.committed).toBeGreaterThanOrEqual(1)
    ;[t] = await admin<{ plan: string; pending_plan: string | null }[]>`SELECT plan, pending_plan FROM tenants WHERE id = ${TENANT}`
    expect(t.plan).toBe('free')         // downgrade committed
    expect(t.pending_plan).toBeNull()   // cleared

    // Idempotent: a re-run has nothing pending to commit.
    const again = await reconcilePlans(admin, { graceSeconds: 0 })
    expect(again.committed).toBe(0)
  })
})
