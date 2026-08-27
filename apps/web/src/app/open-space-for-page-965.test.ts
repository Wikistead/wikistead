// @vitest-environment happy-dom
//
// `routes.tsx` resolves the collaboration URL at module scope from `window.location`, so importing it
// at all needs a document (see workspace-create-message-806.test.ts's own note on this).
//
// #965 (review): the fix landed once already and was bounced back — not because the
// mechanism was wrong, but because nothing pinned it. The e2e that exercised it shares a spec with
// #940's ~1/3 intermittent flake, so a single red/green run there proves nothing either way. This pins
// the pure ref-gate rule directly: no DOM, no background-refetch timing, no #940 entanglement.
import { describe, it, expect } from "vitest";
import { openSpaceForPageDecision } from "./routes";

describe("#965: openSpaceForPageDecision — the sidebar follows the OPEN PAGE, not every effect fire", () => {
  it("a page's space is applied the first time this page is seen", () => {
    expect(openSpaceForPageDecision(undefined, "page-1", "space-a"))
      .toEqual({ apply: true, appliedFor: "page-1", spaceId: "space-a" });
  });

  // THE regression this ticket is about: a background refetch (a space created elsewhere in the tree,
  // unrelated to this page) re-fires the effect for the SAME page. The old implementation re-asserted
  // `openSpaceId` unconditionally and overwrote a selection the sidebar had just made on its own.
  it("a re-fire for the SAME page is a no-op, whatever re-fired it", () => {
    expect(openSpaceForPageDecision("page-1", "page-1", "space-a")).toEqual({ apply: false });
  });

  it("navigating to a DIFFERENT page applies that page's space", () => {
    expect(openSpaceForPageDecision("page-1", "page-2", "space-b"))
      .toEqual({ apply: true, appliedFor: "page-2", spaceId: "space-b" });
  });

  it("a page whose space has not loaded yet applies nothing (and does not touch the ref)", () => {
    expect(openSpaceForPageDecision(undefined, "page-1", undefined)).toEqual({ apply: false });
    expect(openSpaceForPageDecision("page-1", "page-2", undefined)).toEqual({ apply: false });
  });

  // Break-check for the assertion above, not just the behaviour: a mutation that always returns
  // apply:false would pass "a re-fire is a no-op" vacuously. This pins that the FIRST case is not that.
  it("break-check: the no-op case and the apply case are not the same answer", () => {
    const first = openSpaceForPageDecision(undefined, "page-1", "space-a");
    const reFire = openSpaceForPageDecision("page-1", "page-1", "space-a");
    expect(first.apply, "the mutation-under-test must actually distinguish these").toBe(true);
    expect(reFire.apply).toBe(false);
  });
});
