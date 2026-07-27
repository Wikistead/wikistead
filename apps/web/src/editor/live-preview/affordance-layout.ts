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

export function resolveAffordanceLayout(view: EditorView): Placed[] {
  const els = Array.from(view.dom.querySelectorAll<HTMLElement>(AFFORDANCE_SEL));
  if (els.length < 2) return els.map((el) => ({ el, top: 0, bottom: 0, left: 0, right: 0, dy: 0 }));

  // Priority order across the WHOLE viewport, not per block: two affordances of different blocks are far
  // apart and simply never intersect, so one uniform pass handles both "same block" and "nested block"
  // without having to decide which block an element belongs to (the pill is not even inside the wrap).
  const rank = (el: HTMLElement): number => AFFORDANCES.findIndex((sel) => el.matches(sel));
  const candidates = els
    .filter((el) => isVisible(el))
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
      this.onSettle = () => this.schedule(view);
      view.dom.addEventListener("pointerover", this.onSettle);
      view.dom.addEventListener("transitionend", this.onSettle);
      this.schedule(view);
    }
    onSettle: () => void;
    update(u: ViewUpdate) { this.schedule(u.view); }
    destroy(): void { /* listeners die with view.dom */ }
    schedule(view: EditorView): void {
      view.requestMeasure({
        key: this,
        read: () => resolveAffordanceLayout(view),
        write: (placed) => {
          for (const p of placed) {
            const t = p.dy ? `translateY(${Math.round(p.dy)}px)` : "";
            if (p.el.style.transform !== t) p.el.style.transform = t;
          }
        },
      });
    }
  },
);
