// #758 / ADR-183 §3: the degradation this codebase chose, made visible to the person running it.
//
// ADR-183 traded "the tree 500s when the store hiccups" for "an id the store could not answer is
// denied, and the reader sees fewer rows". That trade is deliberate and it is the right one for a read
// surface. What it never got is the second half of its own sentence — the ADR's default proposal was
// "accept for v1 … **log a warn per degraded batch**" — so for months the thinning happened in silence.
// Nobody could answer "is this happening in production?", because nothing anywhere said it had.
//
// The shape of the silence is worth naming, because it is what makes this worse than an ordinary
// missing log. When the store thins a list, the RESULT IS INDISTINGUISHABLE from the truth: a page the
// reader genuinely cannot see and a page the store could not answer for both arrive as absence. There
// is no error, no status, no gap in the numbering — the tree simply has fewer rows in it, and it looks
// exactly like a tree that has fewer rows in it. A support ticket that begins "a page vanished from my
// sidebar" has, today, no evidence anywhere that could confirm or refute it.
//
// This is a PORT, not a logger. `@wikistead/authz` must not learn how this deployment writes logs — it
// has no logger dependency today and acquiring one would put a runtime dependency under ADR-011's
// licence gate for the sake of one warn. It reports; the composition root decides where that goes. Same
// shape as the restriction evaluator next door, for the same reason.
//
// ⚠️ OBSERVATION ONLY. A sink cannot change a verdict, and this module goes out of its way to keep that
// true: the return value is ignored and a sink that throws is swallowed. An authorization answer must
// never depend on whether logging worked.

/** One batch in which the store did not answer for every id on the first, widest attempt. */
export interface AuthzDegradation {
  /** The relation asked about — an FGA word (`view`, `access_manager`). Operator-facing only (#619). */
  relation: string
  /** `page` | `space` — which type the ids named. */
  resourceType: string
  /** Ids in the batch. A COUNT OF CANDIDATES, taken before authorization ran (#623 §4 — never a body). */
  candidates: number
  /** How many of them the store could not answer, and which were therefore reported as denied. */
  unanswered: number
  /**
   * #799: how many ids the store went silent about on the first, wide round-trip and then answered
   * when they were asked again in narrower ones. These cost nobody a row — they are here because a
   * batch that only just made it and a batch that did not should not look the same in a log, and
   * because a rising number is the store telling an operator it is running out of deadline.
   */
  recovered: number
  /**
   * The store's own words for the first failure — `deadline_exceeded` is the one seen in the wild.
   * #816: an id the store never spoke about brings no words of its own, so a batch thinned by SILENCE
   * carries a fixed sentence saying that instead. An empty string next to a non-zero count would read
   * as a broken report rather than as what happened.
   */
  firstError: string
}

export type AuthzDegradationSink = (d: AuthzDegradation) => void

let _sink: AuthzDegradationSink | null = null

export function registerAuthzDegradationSink(sink: AuthzDegradationSink): void { _sink = sink }

/** For tests, and for a composition root that tears itself down. */
export function resetAuthzDegradationSink(): void { _sink = null }

/** Whether a sink is wired. The boot pin asks this — an unregistered port reports to nobody. */
export function hasAuthzDegradationSink(): boolean { return _sink !== null }

/**
 * Report a thinned batch. Never throws, never blocks, never influences the verdict.
 *
 * The try/catch is not defensive habit: without it, a sink that throws would propagate out of
 * `filterAuthorized` and turn a DEGRADED read into a FAILED one — logging would have changed the
 * answer, which is the one thing an observation port must not do.
 */
export function reportAuthzDegradation(d: AuthzDegradation): void {
  if (!_sink) return
  try { _sink(d) } catch { /* an observation must never become the outcome */ }
}
