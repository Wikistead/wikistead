import { isGuestSub } from "../comments/AuthorChip";

// #327 / ADR-143: the latest contiguous same-actor run (client-side mirror of the server's derivation —
// display only; the server is the fortress). null when there are no revisions or the newest has no
// recorded actor. Pure module (no component imports) so theguards are unit-testable.
export function latestRun(revisions: { createdBy: string | null }[]): { actor: string; count: number; hasBaseline: boolean } | null {
  const first = revisions[0]?.createdBy;
  if (!first) return null;
  let count = 0;
  while (count < revisions.length && revisions[count]!.createdBy === first) count++;
  return { actor: first, count, hasBaseline: count < revisions.length };
}

//(review ruling): the one-click bulk revert is offered ONLY for an anonymous (anon:/guest:)
// run of 2+ revisions. A member's edits or a single revision never grow a bulk affordance — on an
// interleaved page that one-click would restore whatever lies beneath (possibly a buried vandal
// version), which is the exact footgun the feature exists to remove. The server enforces the same
// contract (runLen < 2 → 409 not-a-run), so a hand-crafted API call cannot bypass this either.
export function isRevertableRun(run: { actor: string; count: number } | null): boolean {
  return run !== null && isGuestSub(run.actor) && run.count >= 2;
}
