// #1130: #1123 unified the placeholder row's label size with a page name (14px, tokens.css's
// --text-ui — the tree's own base, via Sidebar.tsx:328's inherited size) but left the tree's other
// two synthetic rows at `text-xs` (11px, tokens.css's --text-xs) — worse than the 12px #1123 fixed.
// Ruling (this ticket): unify all three rather than invent a new "openable vs informational" size
// tier that exists nowhere else in the codebase — the "some pages could not be shown" row (the
// tree-placeholders-exhausted testid below) in particular tells the reader something (#1093), so
// it must not read smaller than a page name.
//
// PageTree.tsx is a react-arborist row renderer with heavy runtime deps (drag handles, virtualized
// list context) — not practical to render standalone here. #1123's own regression guard was a real
// computed-style e2e measurement (lazy-tree-623.spec.ts, outside GATE_SPECS per #1078); this pin
// takes the same fallback #1105 used for un-renderable spots: read the shipped source. Each check is
// scoped to the enclosing FUNCTION/BLOCK (not a single line — the JSX wraps the size class and the
// label onto different lines — and not a whole-file indexOf, which could borrow an unrelated match).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = readFileSync(resolve(import.meta.dirname, "PageTree.tsx"), "utf8");

function slice(startNeedle: string, endNeedle: string): string {
  const start = SRC.indexOf(startNeedle);
  expect(start, `expected to find ${JSON.stringify(startNeedle)}`).toBeGreaterThan(-1);
  const end = SRC.indexOf(endNeedle, start);
  expect(end, `expected to find ${JSON.stringify(endNeedle)} after the start`).toBeGreaterThan(start);
  return SRC.slice(start, end);
}

describe("#1130: the tree's remaining two synthetic rows inherit 14px like a page name", () => {
  // Matched only inside a className="..." VALUE — not the surrounding prose, whose own explanation
  // of the defect necessarily mentions "text-xs" as text (a plain word-boundary match on the whole
  // block would flag the comment describing the fix as if it were the bug).
  const CLASS_HAS_SIZE_OVERRIDE = /className="[^"]*\btext-(?:xs|sm)\b/;

  // #1149 (ruling): this row's own visible label is gone (idle: nothing at all; fetching: a
  // textless skeleton), so the original concern here — a font-size override on ITS text — no longer
  // has anything to apply to. What still matters is that the label stays gone: no button, and no
  // reference to the retired locale key, so a future edit can't quietly bring the text back undersized
  // (or at all) without this test noticing.
  it('"load more" (tree-branch-more, MoreRow) has no button and no label — idle renders nothing', () => {
    const body = slice("function MoreRow(", "\nexport function PageTree(");
    expect(body).not.toContain("sidebar.loadMorePages");
    expect(body).not.toMatch(/<button/);
    expect(body).not.toMatch(CLASS_HAS_SIZE_OVERRIDE);
  });

  // #1141 / ADR-220 §4.2 rev13: the "some pages could not be shown" dead-end row (tree-placeholders-
  // exhausted) is retired — the placeholder walk's continuation row now renders through the SAME
  // `MoreRow` component the branch's own "load more" row uses (checked above), so there is no second,
  // independent block whose font size could drift from it; the invariant this test originally pinned
  // holds by construction rather than by a separate assertion.
  it('the placeholder-walk continuation row (ph-more:) renders through MoreRow, not a separate block', () => {
    const body = slice("d.id.startsWith(PLACEHOLDERS_MORE_PREFIX)", "d.id.startsWith(PLACEHOLDER_PREFIX)");
    expect(body).toContain("<MoreRow");
    expect(body).not.toMatch(CLASS_HAS_SIZE_OVERRIDE);
  });
});
