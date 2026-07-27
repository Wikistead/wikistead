import { ViewPlugin, type EditorView, type ViewUpdate } from "@codemirror/view";

// #528 / ADR-192: ONE layout owner for every block affordance.
//
// The affordances a macro block can show — the ✎/Ctrl+↵ chrome row, the raw-mode rich-edit pill, and the
// remote-presence box — were each positioned by their own CSS, and each claimed the SAME corner
// (`top: -1.5em; left: 0`). They never knew about one another, so whichever two happened to be visible at
// once simply overlapped (measured on `::::columns > :::column > :::note`: the pill at y185–202 and the ✎
// row at y174–193, an 8px collision).
//
// CSS cannot fix this, and that was measured too (#528): the pill is a CodeMirror widget living in
// the raw source line while the chrome row is absolute chrome on the wrap, so THEY HAVE DIFFERENT OFFSET
// PARENTS — nudging one with `top` moves it by an amount the other's coordinate space knows nothing about.
// Fitting numbers together per-pair is exactly the "enumerate the collisions" approach this ticket rejects.
//
// So the owner does what only an owner can: it measures every visible affordance against ONE origin (the
// viewport, via getBoundingClientRect), and resolves the whole set at once. Overlaps are impossible by
// construction rather than by a list of special cases — a new affordance added later is placed by the same
// rule without touching this file's logic.
//
// Invariants (the approval conditions on ADR-192):
//   - MEASURE-PHASE ONLY. This never dispatches, never touches the document, and never reads or writes
//     Yjs/collab state — it only reads rectangles and writes a transform (#92 regression class).
//   - PRESENCE NEVER MOVES. #453 aligned the remote-presence box with the local atom-selection ring; if
//     this owner shifted it, that geometry would silently regress. Presence is placed first and pinned.
//   - NOTHING IS HIDDEN TO RESOLVE A COLLISION. The failure mode of a slot system is "no longer overlapping,
//     no longer visible" (#456 was rejected for exactly that). Displaced affordances stay on screen: the
//     owner keeps them inside the scroller, flipping BELOW the block when there is no room above.

// The affordances this owner places. Order = priority; earlier wins the contested slot.
// (`.cm-macro-presence-box` is the remote-presence box from macro-presence-overlay.ts.)
const AFFORDANCES = [
  ".cm-macro-presence-box",
  ".cm-lp-macro-btnrow",
  ".cm-lp-macro-richui-raw",
] as const;
const AFFORDANCE_SEL = AFFORDANCES.join(", ");
// Presence is placed but never displaced (see the #453 invariant above).
const PINNED = ".cm-macro-presence-box";
// Affordances whose visibility the OWNER decides (see the plugin): their current computed style is not the
// answer during a measure — the answer is whether the owner is about to show them.
const OWNER_GATED = ".cm-lp-macro-richui-raw";

const GAP = 3; // px between stacked affordance rows

interface Placed { readonly el: HTMLElement; top: number; bottom: number; left: number; right: number; dy: number }

const overlaps = (a: Placed, b: Placed): boolean =>
  a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

// Is this element actually on screen? A hover-gated affordance sits at opacity 0 until the pointer arrives,
// and an invisible element must NOT reserve a slot (that would displace the visible one for no reason).
function isVisible(el: HTMLElement): boolean {
  const cs = getComputedStyle(el);
  if (cs.visibility === "hidden" || cs.display === "none") return false;
  return parseFloat(cs.opacity || "1") > 0.01;
}

// #528(user measurement, which overturned the earlier "innermost-only already holds" report — that
// check counted visible affordances without asking which block owned them): exactly ONE block offers entry
// chrome. The focused block is the innermost wrap holding the caret; with the caret elsewhere it is the
// innermost wrap under the pointer; caret wins when both apply. Ancestors stay quiet while a descendant is
// focused, and an unrelated block shows nothing at all.
export function focusedWrap(view: EditorView, pointer: { x: number; y: number } | null): HTMLElement | null {
  const wraps = Array.from(view.dom.querySelectorAll<HTMLElement>(".cm-lp-macro-wrap"));
  if (wraps.length === 0) return null;
  const innermost = (candidates: HTMLElement[]) =>
    candidates.find((w) => candidates.every((o) => o === w || o.contains(w))) ?? null;

  // caret first — `coordsAtPos` puts it in the same viewport space as the wrap rectangles
  const head = view.state.selection.main.head;
  const c = view.coordsAtPos(head);
  if (c) {
    const holding = wraps.filter((w) => {
      const r = w.getBoundingClientRect();
      return c.top >= r.top - 2 && c.bottom <= r.bottom + 2 && c.left >= r.left - 2 && c.left <= r.right + 2;
    });
    const byCaret = innermost(holding);
    if (byCaret) return byCaret;
  }
  if (!pointer) return null;
  const under = wraps.filter((w) => {
    const r = w.getBoundingClientRect();
    // include the gutter above the block, where its chrome row lives
    return pointer.x >= r.left && pointer.x <= r.right && pointer.y >= r.top - 24 && pointer.y <= r.bottom;
  });
  return innermost(under);
}

// `focus` is the block the owner is ABOUT to show chrome for. Placement must be computed against what the
// write pass will make visible, not against what is visible right now — otherwise an affordance shown by
// this very pass was never measured, and lands unplaced. (That is exactly what a first cut of the owner-
// driven visibility did: the static case came back with the original 8px collision.)
export function resolveAffordanceLayout(view: EditorView, focus: HTMLElement | null = null): Placed[] {
  const els = Array.from(view.dom.querySelectorAll<HTMLElement>(AFFORDANCE_SEL));
  if (els.length < 2) return els.map((el) => ({ el, top: 0, bottom: 0, left: 0, right: 0, dy: 0 }));

  // Priority order across the WHOLE viewport, not per block: two affordances of different blocks are far
  // apart and simply never intersect, so one uniform pass handles both "same block" and "nested block"
  // without having to decide which block an element belongs to (the pill is not even inside the wrap).
  const rank = (el: HTMLElement): number => AFFORDANCES.findIndex((sel) => el.matches(sel));
  // "visible" means visible AFTER this pass: an owner-gated affordance counts when its block is focused.
  const willShow = (el: HTMLElement) =>
    el.matches(OWNER_GATED) ? focus != null && focus.contains(el) : isVisible(el);
  const candidates = els
    .filter(willShow)
    .map((el) => ({ el, r: el.getBoundingClientRect() }))
    .filter((c) => c.r.width > 0 && c.r.height > 0)
    .sort((a, b) => rank(a.el) - rank(b.el) || a.r.top - b.r.top);

  const bounds = view.scrollDOM.getBoundingClientRect();
  const placed: Placed[] = [];
  for (const { el, r } of candidates) {
    const cur: Placed = { el, top: r.top, bottom: r.bottom, left: r.left, right: r.right, dy: 0 };
    if (el.matches(PINNED)) { placed.push(cur); continue; } // #453: presence is authoritative, never moved

    const step = r.height + GAP;
    // Try the reserved rows ABOVE first (that is where this chrome lives), then flip BELOW. The flip is the
    // slot policy for "every row above is taken": docking downward keeps the affordance beside its own block
    // and on screen, whereas stacking further up eventually leaves the scroller — i.e. it would be invisible,
    // which the approval conditions forbid outright.
    const offsets: number[] = [];
    for (let i = 1; i <= 4; i++) offsets.push(-i * step);
    for (let i = 1; i <= 4; i++) offsets.push(i * step);
    for (const dy of [0, ...offsets]) {
      const cand: Placed = { ...cur, top: r.top + dy, bottom: r.bottom + dy, dy };
      if (cand.top < bounds.top || cand.bottom > bounds.bottom) continue; // would leave the visible surface
      if (placed.some((p) => overlaps(cand, p))) continue;
      placed.push(cand);
      break;
    }
    // Nothing free anywhere on screen: keep the element where it is. Overlapping is bad; vanishing is worse.
    if (!placed.includes(cur) && !placed.some((p) => p.el === el)) placed.push(cur);
  }
  return placed;
}

export const affordanceLayout = ViewPlugin.fromClass(
  class {
    constructor(view: EditorView) {
      // The set to resolve changes WITHOUT a transaction in two ways, and both were measured, not guessed:
      //   - hover flips a gated affordance from opacity 0 to visible;
      //   - the pill FADES IN over 120ms, so a measure taken in the same frame as the update still reads
      //     opacity 0 and would conclude there is nothing to resolve (this is why the first cut of this
      //     plugin left the 8px collision in place).
      // Both are answered by re-measuring on the DOM events that mark them. Neither dispatches.
      // The owner now decides VISIBILITY as well as placement, so the two can never disagree: it marks the
      // focused wrap and the affordances it shows in the same measure pass that positions them. Pointer
      // position is tracked (measure-only, never dispatched) because "which block is under the pointer" is
      // an input to that decision — it is not an event we react to after CSS has already shown something.
      this.pointer = null;
      this.onMove = (e: PointerEvent) => { this.pointer = { x: e.clientX, y: e.clientY }; this.schedule(view); };
      this.onLeave = () => { this.pointer = null; this.schedule(view); };
      view.dom.addEventListener("pointermove", this.onMove);
      view.dom.addEventListener("pointerleave", this.onLeave);
      this.schedule(view);
    }
    pointer: { x: number; y: number } | null;
    onMove: (e: PointerEvent) => void;
    onLeave: () => void;
    update(u: ViewUpdate) { this.schedule(u.view); }
    destroy(): void { /* listeners die with view.dom */ }
    schedule(view: EditorView): void {
      view.requestMeasure({
        key: this,
        read: () => {
          const focus = focusedWrap(view, this.pointer);
          return { placed: resolveAffordanceLayout(view, focus), focus };
        },
        write: ({ placed, focus }) => {
          // one wrap wears the focus mark; the CSS that used to react to `:hover` now reacts to this
          for (const w of Array.from(view.dom.querySelectorAll<HTMLElement>(".cm-lp-macro-wrap"))) {
            w.classList.toggle("cm-aff-focus", w === focus);
          }
          // an affordance is shown only if the focused block owns it — and it is placed in the same pass,
          // so there is no frame where it is on screen without the owner having measured it (#528)
          for (const el of Array.from(view.dom.querySelectorAll<HTMLElement>(".cm-lp-macro-richui-raw"))) {
            el.classList.toggle("cm-aff-shown", focus != null && focus.contains(el));
          }
          for (const p of placed) {
            const t = p.dy ? `translateY(${Math.round(p.dy)}px)` : "";
            if (p.el.style.transform !== t) p.el.style.transform = t;
          }
        },
      });
    }
  },
);
