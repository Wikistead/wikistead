// Metered-usage soft-cap + alert decision logic (#128 / ADR-082) — the PURE mechanism core, with no
// I/O. The durable usage ledger (usage_counters migration, outbox-drained idempotent increment, RLS),
// the per-resource Entitlements allowance fields, and the consumer wiring (#130 ai.tokens / #112
// storage.bytes) are separate sub-tasks; these two functions are the decision heart they all share,
// kept pure so they are exhaustively unit-testable (entitlement⟂authz; numbers are a business
// placeholder — only the SHAPE/behavior live here).

export interface AllowanceDecision {
  // May the caller consume MORE of this resource right now? (Check BEFORE consuming.)
  allowed: boolean
  // Current accumulated usage in the period.
  usage: number
  // The allowance (soft cap). Infinity = no cap (self-host UNLIMITED → inert).
  cap: number
  // Headroom left before the cap; Infinity when uncapped, never negative.
  remaining: number
}

// Non-destructive soft cap (ADR-082 / ADR-072): NEW consumption is refused once usage has REACHED
// the cap (`usage >= cap`); existing data/usage is never touched. An uncapped resource (Infinity —
// self-host, or a tier with no meter) always allows and short-circuits the headroom math, so metering
// is inert with zero per-call overhead on Community/self-host.
export function decideAllowance(usage: number, cap: number): AllowanceDecision {
  if (!(cap >= 0)) cap = 0 // NaN/negative cap → treat as 0 (fail closed: refuse new consumption)
  const uncapped = cap === Infinity
  return {
    allowed: uncapped || usage < cap,
    usage,
    cap,
    remaining: uncapped ? Infinity : Math.max(0, cap - usage),
  }
}

// Which alert thresholds (as fractions of the cap, e.g. 0.8, 1.0) were NEWLY crossed by moving usage
// from `prev` to `next`? Returns only the thresholds strictly above `prev` and at/below `next`, so an
// alert fires ONCE per threshold per period (the caller dedups durably via the ledger; this just says
// "which boundaries did THIS increment pass"). Uncapped (Infinity) or non-positive cap → never alerts.
// Order-preserving and de-duplicated on the provided thresholds.
export function crossedThresholds(prev: number, next: number, cap: number, thresholds: number[]): number[] {
  if (!(cap > 0) || cap === Infinity || next <= prev) return []
  const seen = new Set<number>()
  const out: number[] = []
  for (const t of thresholds) {
    if (seen.has(t)) continue
    seen.add(t)
    const mark = t * cap
    if (mark > prev && mark <= next) out.push(t)
  }
  return out
}
