// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { focusedWrap } from "./affordance-layout";

// #528 (user measurement): with the caret in an inner :::note, the affordance on screen belonged to
// the PARENT columns, and an unrelated tabs block showed one permanently. The earlier report missed it by
// counting visible affordances without asking which block owned them. The rule this pins: exactly one block
// is focused — the innermost holding the caret, else the innermost under the pointer, caret winning when
// both apply. These drive the decision directly, so the ruling is verified without a browser.

// A wrap at a known rectangle. happy-dom has no layout, so the rects are stubbed — which is what lets this
// test state the geometry the browser would otherwise have to produce.
function wrap(parent: HTMLElement, rect: { top: number; bottom: number; left: number; right: number }) {
  const el = parent.ownerDocument.createElement("div");
  el.className = "cm-lp-macro-wrap";
  el.getBoundingClientRect = () => ({
    top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right,
    width: rect.right - rect.left, height: rect.bottom - rect.top, x: rect.left, y: rect.top, toJSON: () => ({}),
  }) as DOMRect;
  parent.appendChild(el);
  return el;
}

function fakeView(dom: HTMLElement, caret: { top: number; bottom: number; left: number } | null) {
  return {
    dom,
    state: { selection: { main: { head: 42 } } },
    coordsAtPos: () => (caret ? { top: caret.top, bottom: caret.bottom, left: caret.left, right: caret.left } : null),
  } as unknown as Parameters<typeof focusedWrap>[0];
}

describe("#528 which block is focused", () => {
  const build = () => {
    const root = document.createElement("div");
    // outer columns 100..300, inner note 150..200 inside it, and an unrelated tabs block 400..500
    const outer = wrap(root, { top: 100, bottom: 300, left: 0, right: 500 });
    const inner = wrap(outer, { top: 150, bottom: 200, left: 20, right: 480 });
    const unrelated = wrap(root, { top: 400, bottom: 500, left: 0, right: 500 });
    return { root, outer, inner, unrelated };
  };

  it("the caret inside a nested block focuses the INNER one, never its ancestor", () => {
    const { root, inner } = build();
    const view = fakeView(root, { top: 160, bottom: 172, left: 100 });
    expect(focusedWrap(view, null)).toBe(inner);
  });

  it("the caret wins over the pointer when they disagree", () => {
    const { root, inner } = build();
    const view = fakeView(root, { top: 160, bottom: 172, left: 100 });
    // pointer sits over the unrelated block; the caret still decides
    expect(focusedWrap(view, { x: 250, y: 450 })).toBe(inner);
  });

  it("with the caret outside every block, the pointer picks the innermost under it", () => {
    const { root, inner, outer } = build();
    const view = fakeView(root, { top: 900, bottom: 912, left: 10 }); // caret below everything
    expect(focusedWrap(view, { x: 100, y: 175 }), "inside the nested one").toBe(inner);
    expect(focusedWrap(view, { x: 100, y: 280 }), "inside the container only").toBe(outer);
  });

  it("nothing is focused when neither the caret nor the pointer is on a block", () => {
    const { root } = build();
    const view = fakeView(root, { top: 900, bottom: 912, left: 10 });
    expect(focusedWrap(view, { x: 100, y: 950 })).toBeNull();
    expect(focusedWrap(view, null)).toBeNull();
  });

  it("an unrelated block is never focused just for existing", () => {
    const { root, unrelated } = build();
    const view = fakeView(root, { top: 160, bottom: 172, left: 100 });
    expect(focusedWrap(view, null)).not.toBe(unrelated);
  });

  it("the block's own gutter counts as the block — its chrome row lives above it", () => {
    const { root, outer } = build();
    const view = fakeView(root, null); // no caret at all
    expect(focusedWrap(view, { x: 100, y: 90 }), "10px above the container's top edge").toBe(outer);
  });
});
