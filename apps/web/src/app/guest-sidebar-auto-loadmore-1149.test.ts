// #1149 (ruling, applying #903 "the guest surface must not fork the house mechanism"): the guest
// tree's "load more" continuation used to be a real, hand-pressed <button> — the ONE affordance in this
// shell the member tree's own equivalent (PageTree's MoreRow) does not have, since MoreRow auto-fetches
// on scroll/keyboard/pointer traffic instead of waiting to be clicked. That asymmetry is what found:
// removing the label text without also removing the manual trigger would have left a guest with a
// "press me, but I say nothing" box.
//
// GuestSidebar has no react-arborist tree (it renders its own plain, unvirtualized nodes — see
// buildTree, above it in the same file), so it is renderable in principle, but this repo has no
// `@testing-library/react`-style DOM-render setup for either sidebar shell today (PageTree.tsx's own
// header comment: "not practical to render standalone here … heavy runtime deps"). This pin follows the
// same fallback #1105 established for un-renderable spots: read the shipped source, scoped to the
// relevant function/block, not a whole-file or single-line match.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const GUEST_SIDEBAR = readFileSync(resolve(import.meta.dirname, "GuestSidebar.tsx"), "utf8");
const PAGE_TREE = readFileSync(resolve(import.meta.dirname, "../sidebar/PageTree.tsx"), "utf8");

function slice(src: string, startNeedle: string, endNeedle: string): string {
  const start = src.indexOf(startNeedle);
  expect(start, `expected to find ${JSON.stringify(startNeedle)}`).toBeGreaterThan(-1);
  const end = src.indexOf(endNeedle, start);
  expect(end, `expected to find ${JSON.stringify(endNeedle)} after the start`).toBeGreaterThan(start);
  return src.slice(start, end);
}

describe("#1149: the guest tree's continuation row auto-loads through the same MoreRow the member tree uses", () => {
  const guestSidebarFn = slice(GUEST_SIDEBAR, "export function GuestSidebar(", "\nfunction GuestNode(");

  it("GuestSidebar has no hand-pressed load-more button left", () => {
    expect(guestSidebarFn).not.toMatch(/<button[^>]*data-testid="guest-tree-load-more"/);
    expect(guestSidebarFn).not.toContain("sidebar.loadMorePages");
    expect(guestSidebarFn).not.toContain("loadingMore");
  });

  it("GuestSidebar renders the shared MoreRow, gated on onLoadMore, when it wires the continuation row", () => {
    expect(guestSidebarFn).toMatch(/onLoadMore\s*&&\s*<MoreRow\b/);
  });

  it("GuestSidebar's MoreRow points its eavesdropping at the guest tree's OWN container, not the member tree's", () => {
    // A wrong (or missing) hostTestId means MoreRow's `closest("[data-testid=...]")` finds no ancestor at
    // all — every scroll/keyboard/pointer event on the guest sidebar would silently do nothing, and the
    // row would never auto-load. This checks both ends of that wiring, not just that a prop was typed.
    expect(guestSidebarFn).toMatch(/hostTestId="guest-sidebar"/);
    expect(GUEST_SIDEBAR).toMatch(/<nav[^>]*data-testid="guest-sidebar"/);
  });

  it("MoreRow is exported and importable from PageTree.tsx (not a private, single-consumer component anymore)", () => {
    expect(PAGE_TREE).toMatch(/^export function MoreRow\(/m);
    expect(GUEST_SIDEBAR).toMatch(/import\s*\{\s*MoreRow\s*\}\s*from\s*"\.\.\/sidebar\/PageTree"/);
  });

  it("MoreRow's own idle state renders nothing (no button, no label) — the shared behavior both callers get", () => {
    const moreRowFn = slice(PAGE_TREE, "export function MoreRow(", "\nexport function PageTree(");
    expect(moreRowFn).not.toMatch(/<button/);
    expect(moreRowFn).not.toContain("sidebar.loadMorePages");
  });
});
