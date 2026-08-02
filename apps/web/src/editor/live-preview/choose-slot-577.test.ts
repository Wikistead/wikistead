// #577: the slot decision, pinned where the bug actually lived.
//
// The review measured the failure and named its cause: the owner rejects any candidate that
// leaves `bounds`, and `bounds` was the CURRENT view's scroller. Inside a nested edit island that
// scroller starts at the block's top edge, so every upward candidate — and the inline ones, which
// keep dy = 0 — is "off screen", leaving the downward flip as the only survivor. Downward is onto the
// block's own drawing (measured: 1111px² inside an excalidraw canvas, with no other affordance on
// screen, so this was never a collision).
//
// My first attempt pinned this through the DOM and could not build the state — two editors with the
// inner one focused — so the pin passed with the fix removed. The decision is pure geometry, so it is
// tested as pure geometry here: the same numbers the review reported, fed in directly. The
// island case is the RED one; the fix is that the caller passes the OUTER scroller's rect.
import { describe, it, expect } from "vitest";
import { chooseSlot, type Rect } from "./affordance-layout";

// the measured scene, rounded: a nested excalidraw inside ::::columns, its pill 19px tall
const PILL = { top: 310, bottom: 329, left: 419, right: 563, width: 144, height: 19 };
const HOST: Rect = { top: 334, bottom: 487, left: 419, right: 734 }; // the block's wrap (315 wide)
const DRAWING: Rect = { top: 340, bottom: 480, left: 505, right: 649 };
const STEP = PILL.height + 3;

const ISLAND_BOUNDS: Rect = { top: 334, bottom: 487, left: 419, right: 734 }; // the island's own scroller
const OUTER_BOUNDS: Rect = { top: 100, bottom: 900, left: 380, right: 900 }; // the page it is drawn on

const rectAt = (dy: number, dx: number) => ({
  top: PILL.top + dy, bottom: PILL.bottom + dy, left: PILL.left + dx, right: PILL.right + dx,
});
const intersects = (a: Rect, b: Rect) =>
  !(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom);

describe("#577: a pill in a nested island is not pushed onto its own block", () => {
  it("the island's own scroller forces the downward flip — the bug, reproduced as numbers", () => {
    const slot = chooseSlot({ r: PILL, bounds: ISLAND_BOUNDS, content: HOST, peers: [], step: STEP });
    // this is what the review saw on the real page: +44px down, and the pill lands on the drawing
    expect(slot, "with the island as bounds there is no upward or inline slot").toEqual({ dy: 44, dx: 0 });
    expect(intersects(rectAt(slot!.dy, slot!.dx), DRAWING), "…and that slot is ON the drawing").toBe(true);
  });

  it("bounded by the surface it is drawn on, the pill stays off the drawing", () => {
    const slot = chooseSlot({ r: PILL, bounds: OUTER_BOUNDS, content: HOST, peers: [], step: STEP });
    expect(slot, "a slot exists").not.toBeNull();
    expect(intersects(rectAt(slot!.dy, slot!.dx), DRAWING), "the chrome does not sit on its block's content").toBe(false);
    expect(slot!.dy, "and it goes UP, where this chrome lives — not down").toBeLessThanOrEqual(0);
  });

  it("the sideways axis is still reachable when the rows above are genuinely taken", () => {
    // peers on the pill's OWN row and on every upward row — only then does it have to move at all.
    // (My first version of this case left the own row free, so the chooser correctly stayed put and
    // the assertion was testing nothing.)
    const peers: Rect[] = [0, 1, 2, 3, 4].map((i) => rectAt(-i * STEP, 0));
    const slot = chooseSlot({ r: PILL, bounds: OUTER_BOUNDS, content: HOST, peers, step: STEP });
    expect(slot, "a slot exists").not.toBeNull();
    expect(slot!.dx, "it moved sideways rather than onto the block").not.toBe(0);
    expect(intersects(rectAt(slot!.dy, slot!.dx), DRAWING)).toBe(false);
  });

  it("keeps the downward flip as the last resort — narrow column, no room beside", () => {
    const narrow: Rect = { top: HOST.top, bottom: HOST.bottom, left: PILL.left, right: PILL.right }; // exactly the pill's width
    const peers: Rect[] = [0, 1, 2, 3, 4].map((i) => rectAt(-i * STEP, 0));
    const slot = chooseSlot({ r: PILL, bounds: OUTER_BOUNDS, content: narrow, peers, step: STEP });
    expect(slot, "hiding it would be worse than overlapping (#456)").not.toBeNull();
    expect(slot!.dy, "nothing above, nothing beside — it goes below").toBeGreaterThan(0);
  });

  it("answers null rather than leaving the surface when there is nowhere at all", () => {
    const tiny: Rect = { top: PILL.top, bottom: PILL.bottom, left: PILL.left, right: PILL.right };
    const peers: Rect[] = [rectAt(0, 0)]; // its own row taken, and no room to move anywhere
    expect(chooseSlot({ r: PILL, bounds: tiny, content: null, peers, step: STEP })).toBeNull();
  });
});

// The chooser is only half the fix: the caller has to hand it the right surface. That wiring is one
// line in resolveAffordanceLayout, and no unit test of a pure function can see it — so it is pinned
// lexically, the way this repo pins other "do not silently revert this" wiring. If it goes back to
// `view.scrollDOM`, an island's chrome is bounded by the island again and the flip returns.
describe("#577: the caller bounds by the surface the chrome is drawn on", () => {
  it("resolveAffordanceLayout climbs to the outermost scroller", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const src = readFileSync(resolve(import.meta.dirname, "./affordance-layout.ts"), "utf8");
    const at = src.indexOf("const bounds =");
    expect(at, "the bounds are computed once").toBeGreaterThan(-1);
    expect(src.slice(at - 500, at + 80), "bounds come from the outermost scroller, not this view's").toContain("outerScroller");
    expect(src).toMatch(/hop\.classList\.contains\("cm-scroller"\)/);
    expect(src.slice(at, at + 80), "not the local scrollDOM").not.toContain("view.scrollDOM.getBoundingClientRect()");
  });
});
