// #715 / ADR-229: the acquisition funnel, reported from CE and recorded (if at all) by the Cloud
// composition — the same seam shape analytics and the audit ledger already use.
//
// ONE ratio decides whether this product's distribution loop works: of the visitors who arrive
// through a share link, how many end up creating their own workspace. Both events are already
// single server routes, so measuring them is two calls rather than an instrumentation project.
// Nothing is added to the browser: no script, no beacon, no pixel, no third party.
//
// THE SIGNATURES ARE THE PRIVACY GUARANTEE, and they are deliberately impossible to misuse: they
// take NO ARGUMENTS. A future collector cannot persist a visitor id, a tenant, a page or an IP
// because none is passed — the promise is enforced by the type, not by a reviewer noticing. The
// guest invariant (no account, no seat, not in the roster) is what makes per-visitor attribution
// off-limits in the first place, so the counters stay daily totals with no join between them.
//
// A CE build registers no collector and therefore writes nothing at all: a self-hoster's deployment
// counts nothing, which is's ruling and the reason this file holds no SQL.

export interface FunnelCollector {
  /** A visitor got in through a share link (a guest token was minted). */
  linkVisit(): void
  /** Someone created a workspace. */
  workspaceCreated(): void
}

let collector: FunnelCollector | null = null

/** Called by the EE/Cloud composition root. CE calls nothing, so nothing is counted. */
export function registerFunnelCollector(c: FunnelCollector): void {
  collector = c
}

/** Test escape: back to the CE default. Module state is per-vitest-file. */
export function resetFunnelCollector(): void {
  collector = null
}

/** Does this build count the funnel at all? */
export function funnelRegistered(): boolean {
  return collector !== null
}

// The two report calls. They never throw and never await: a counter must not be able to fail a
// share-link exchange or a signup, and the caller does not learn whether anything was recorded.
export function reportLinkVisit(): void {
  try { collector?.linkVisit() } catch { /* counting must never break the product */ }
}

export function reportWorkspaceCreated(): void {
  try { collector?.workspaceCreated() } catch { /* same */ }
}
