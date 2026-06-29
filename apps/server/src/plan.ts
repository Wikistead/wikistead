// Plan-downgrade grace model (#131 / ADR-064). Pure helpers — no I/O, fully unit-testable.

// Grace window before a downgrade's reduced entitlements take effect (env-overridable).
// Business placeholder (suggest 7–14 days); the mechanism is value-agnostic.
export const PLAN_DOWNGRADE_GRACE_S = Number(process.env.PLAN_DOWNGRADE_GRACE_S ?? 7 * 24 * 60 * 60)

// Plan ordering for downgrade/upgrade detection. Unknown plans rank as the lowest (free-equiv),
// so an unrecognized target is treated conservatively (a downgrade defers; never an instant cut).
const RANK: Record<string, number> = { free: 0, pro: 1, team: 2 }
export function planRank(plan: string): number {
  return RANK[plan] ?? 0
}
export function isDowngrade(from: string, to: string): boolean {
  return planRank(to) < planRank(from)
}

// The EFFECTIVE plan entitlements resolve from (ADR-064): with a pending downgrade, stay on the
// OLD plan until grace elapses, then the new (lower) plan — even if the reconciling batch hasn't
// committed yet (safe-side: never keep a tenant on a plan they no longer pay for past grace).
// No pending → the plan as-is. The commit flag is the raw `plan`; this derives the boundary.
export function effectivePlan(args: {
  plan: string
  pendingPlan: string | null
  pendingPlanAt: Date | null
  graceSeconds?: number
  now?: number
}): string {
  if (!args.pendingPlan || !args.pendingPlanAt) return args.plan
  const grace = args.graceSeconds ?? PLAN_DOWNGRADE_GRACE_S
  const now = args.now ?? Date.now()
  return args.pendingPlanAt.getTime() + grace * 1000 <= now ? args.pendingPlan : args.plan
}
