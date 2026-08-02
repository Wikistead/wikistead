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
  ".cm-lp-nested-macro-edit",
  ".cm-lp-macro-richui-raw",
] as const;
const AFFORDANCE_SEL = AFFORDANCES.join(", ");
// Presence is placed but never displaced (see the #453 invariant above).
const PINNED = ".cm-macro-presence-box";
// Affordances whose visibility the OWNER decides (see the plugin): their current computed style is not the
// answer during a measure — the answer is whether the owner is about to show them.
// BOTH of them: making the chrome row focus-driven put it in the same bind as the pill. On the first pass
// the row is still invisible (the focus class lands in the WRITE phase), so a read that trusted computed
// style saw no row to collide with, gave the pill dy=0, and the write then made both visible on top of each
// other — the original 8px overlap, reintroduced by the fix for it. Measured, not reasoned: the diagnostic
// showed both elements inside the focused wrap with `transform: none`.
// The hover-variant nested pencil joins the gate (#528): a focused nested slot is a block like any
// other, and its entry chrome is shown by the same pass that places it. The SELECTION pencil (the variant
// without `-hover`) stays out — it is drawn only while the nested macro is selected, a state the owner
// does not drive, and it is visible from birth so plain isVisible() already measures it.
const OWNER_GATED = ".cm-lp-macro-richui-raw, .cm-lp-macro-btnrow, .cm-lp-nested-macro-edit-hover";

const GAP = 3; // px between stacked affordance rows

// One displacement variable per affordance KIND, not per element: focus is single, so at most one of each
// kind is visible at a time and a per-kind variable reaches exactly the element being placed.
function varFor(el: HTMLElement): string | null {
  if (el.matches(".cm-lp-macro-richui-raw")) return "--aff-dy-pill";
  if (el.matches(".cm-lp-macro-btnrow")) return "--aff-dy-row";
  if (el.matches(".cm-lp-nested-macro-edit")) return "--aff-dy-nested";
  return null;
}
// #577: the same variable, one axis over. A NESTED block has no room above (its container's chrome row
// owns that space), so the downward flip was the only slot left — and downward means ON TOP OF THE
// BLOCK'S OWN DRAWING. Sideways is the room a nested block actually has, so the search gained an
// inline axis, and that needs a second variable per kind.
const dxVarFor = (el: HTMLElement): string | null => varFor(el)?.replace("--aff-dy-", "--aff-dx-") ?? null;

interface Placed { readonly el: HTMLElement; top: number; bottom: number; left: number; right: number; dy: number; dx: number }

const overlaps = (a: Placed, b: Placed): boolean =>
  a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

// Is this element actually on screen? A hover-gated affordance sits at opacity 0 until the pointer arrives,
// and an invisible element must NOT reserve a slot (that would displace the visible one for no reason).
function isVisible(el: HTMLElement): boolean {
  const cs = getComputedStyle(el);
  if (cs.visibility === "hidden" || cs.display === "none") return false;
  return parseFloat(cs.opacity || "1") > 0.01;
}

// What counts as a focusable block. NOT just `.cm-lp-macro-wrap`, and that was the #528defect: a
// macro nested inside a layout container HAS NO WRAP OF ITS OWN — measured in a real browser, a
// `::::columns > :::column > :::note` produced exactly two wraps (the columns and an unrelated tabs), and
// the caret inside the note therefore resolved to the CONTAINER. The nested unit is the slot the container
// tags with `data-mac-pos` (decorations.ts, the same handle the hit-test and the nested ✎ use), so the
// focus rule has to speak in those terms or it can never name the inner block.
//
// The edit island counts too, and finding out why took a browser: `mountNestedEditIsland` does
// `slot.replaceWith(host)`, so WHILE a nested macro is being edited its `data-mac-pos` slot is not in the
// document at all — the island stands in its place. A rule that knew only about slots would fall back to
// the container for exactly the state the user reported (caret in the inner note).
const FOCUS_HOSTS = ".cm-lp-macro-wrap, [data-mac-pos], .cm-lp-slot-edit-island, .cm-lp-nested-edit-island";

// #528(user measurement, which overturned the earlier "innermost-only already holds" report — that
// check counted visible affordances without asking which block owned them): exactly ONE block offers entry
// chrome. The focused block is the innermost host holding the caret; with the caret elsewhere it is the
// innermost host under the pointer; caret wins when both apply. Ancestors stay quiet while a descendant is
// focused, and an unrelated block shows nothing at all.
export function focusedWrap(view: EditorView, pointer: { x: number; y: number } | null): HTMLElement | null {
  const wraps = Array.from(view.dom.querySelectorAll<HTMLElement>(FOCUS_HOSTS));
  if (wraps.length === 0) return null;
  const innermost = (candidates: HTMLElement[]) =>
    candidates.find((w) => candidates.every((o) => o === w || o.contains(w))) ?? null;

  // Caret first, located through the DOM rather than through coordinates: with the caret inside a macro the
  // block is often revealed as RAW source, and `coordsAtPos` then reports a position the rendered wrap's
  // rectangle no longer covers — measured as `focus:false` while the caret was plainly inside the block.
  // The wrap that CONTAINS the cursor element is the answer, and it does not depend on geometry at all.
  const cursorEl = view.dom.querySelector<HTMLElement>(".cm-cursor-primary") ?? view.dom.querySelector<HTMLElement>(".cm-cursor");
  const byDom = cursorEl ? innermost(wraps.filter((w) => w.contains(cursorEl))) : null;
  if (byDom) return byDom;
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
    // include the gutter above the block, where its chrome row lives — but a NESTED host's gutter stops
    // at its container's content edge. A slot near the top of a columns block would otherwise project its
    // gutter into the strip above the container where the CONTAINER's chrome row sits, so the pointer
    // travelling up to that row flipped focus to the slot halfway there and the row vanished under the
    // click (#528"the button is there, then it isn't").
    let gutterTop = r.top - 24;
    const container = w.parentElement?.closest(".cm-lp-macro-wrap");
    if (container) gutterTop = Math.max(gutterTop, container.getBoundingClientRect().top);
    return pointer.x >= r.left && pointer.x <= r.right && pointer.y >= gutterTop && pointer.y <= r.bottom;
  });
  return innermost(under);
}

// `focus` is the block the owner is ABOUT to show chrome for. Placement must be computed against what the
// write pass will make visible, not against what is visible right now — otherwise an affordance shown by
// this very pass was never measured, and lands unplaced. (That is exactly what a first cut of the owner-
// driven visibility did: the static case came back with the original 8px collision.)
// #577: the slot decision, as data. It used to live inline in the loop below, where the only way to
// test it was to reproduce a whole browser state — which is how the first attempt at this ticket
// shipped a pin that could not go red. Everything it needs is geometry, so it takes geometry: the
// element's own rect, the surface it may occupy, its host's rect (for the sideways room) and whatever
// is already placed. The caller still owns the DOM.
export interface Rect { top: number; bottom: number; left: number; right: number }
export interface SlotInput {
  r: Rect & { width: number; height: number };
  bounds: Rect;
  content: Rect | null;
  peers: Rect[];
  step: number;
}
export function chooseSlot({ r, bounds, content, peers, step }: SlotInput): { dy: number; dx: number } | null {
  const inlineRoom = content ? content.right - r.left - r.width : 0;
  const cands: { dy: number; dx: number }[] = [{ dy: 0, dx: 0 }];
  for (let i = 1; i <= 4; i++) cands.push({ dy: -i * step, dx: 0 });
  // sideways: flush right inside the host, then the mirror to the left, both on the ORIGINAL row
  if (inlineRoom > 0) cands.push({ dy: 0, dx: Math.round(inlineRoom) });
  if (content && r.left - content.left > 0) cands.push({ dy: 0, dx: -Math.round(r.left - content.left) });
  for (let i = 1; i <= 4; i++) cands.push({ dy: i * step, dx: 0 });
  for (const { dy, dx } of cands) {
    const cand = { top: r.top + dy, bottom: r.bottom + dy, left: r.left + dx, right: r.right + dx };
    if (cand.top < bounds.top || cand.bottom > bounds.bottom) continue; // would leave the visible surface
    if (cand.left < bounds.left || cand.right > bounds.right) continue; // …in either axis
    if (peers.some((p) => !(cand.right <= p.left || cand.left >= p.right || cand.bottom <= p.top || cand.top >= p.bottom))) continue;
    return { dy, dx };
  }
  return null; // nothing free anywhere on screen
}

export function resolveAffordanceLayout(view: EditorView, focus: HTMLElement | null = null): Placed[] {
  const els = Array.from(view.dom.querySelectorAll<HTMLElement>(AFFORDANCE_SEL));
  // With fewer than two affordances present there is nothing to resolve, so the owner says NOTHING rather
  // than saying "dy: 0". The difference matters: an instruction of 0 clears the transform, and CodeMirror
  // rebuilds the chrome row as the pointer crosses it — so a pass landing in that gap used to wipe the
  // placement computed a frame earlier, and the pair reappeared on top of each other. That is the flicker
  // in the report, reproduced here as "pill lost its displacement" on 13 of 12 sampled steps.
  if (els.length < 2) return [];

  // Priority order across the WHOLE viewport, not per block: two affordances of different blocks are far
  // apart and simply never intersect, so one uniform pass handles both "same block" and "nested block"
  // without having to decide which block an element belongs to (the pill is not even inside the wrap).
  const rank = (el: HTMLElement): number => AFFORDANCES.findIndex((sel) => el.matches(sel));
  // "visible" means visible AFTER this pass: an owner-gated affordance counts when its block is focused.
  // OR, not replace: an owner-gated affordance is also shown by its block being in RAW mode, a rule the
  // owner does not drive. Treating "the owner will show it" as the only way to be visible left the raw case
  // unmeasured — and unmeasured means unplaced, which is the original 8px collision all over again.
  // "Its block is focused" means the element's OWN host is the focus — closest(), not contains(). A
  // container wrap CONTAINS every nested slot inside it, so a containment test would light up the
  // container chrome and all of its children's pencils together the moment the pointer touched the
  // container margin — the many-similar-buttons screenremoved, rebuilt one level down.
  const willShow = (el: HTMLElement) =>
    isVisible(el) || (el.matches(OWNER_GATED) && focus != null && el.closest(FOCUS_HOSTS) === focus);
  // Measure where each affordance would sit WITHOUT the displacement this owner already applied. A rect
  // reflects the transform, so measuring it raw means reading back our own answer: the pair looks resolved,
  // the pass concludes dy 0, the element snaps home, the next pass displaces it again — an oscillation that
  // showed up as the pair overlapping on every other sampled frame while the pointer moved. Subtracting the
  // current variable turns the reading back into the block's own geometry.
  const applied = (el: HTMLElement): number => {
    const name = varFor(el);
    if (!name) return 0;
    return parseFloat(view.dom.style.getPropertyValue(name) || "0") || 0;
  };
  const appliedX = (el: HTMLElement): number => {
    const name = dxVarFor(el);
    if (!name) return 0;
    return parseFloat(view.dom.style.getPropertyValue(name) || "0") || 0;
  };
  const candidates = els
    .filter(willShow)
    .map((el) => {
      const b = el.getBoundingClientRect();
      const dy = applied(el);
      const dx = appliedX(el);
      return { el, r: { top: b.top - dy, bottom: b.bottom - dy, left: b.left - dx, right: b.right - dx, width: b.width, height: b.height } };
    })
    .filter((c) => c.r.width > 0 && c.r.height > 0)
    .sort((a, b) => rank(a.el) - rank(b.el) || a.r.top - b.r.top);

  // #577 (review, root cause measured): the bound is the surface the chrome is DRAWN on, which is
  // not always this view's own scroller. Inside a nested edit island the island's scroller starts at the
  // block's top edge, so every upward candidate — and the inline ones, which keep dy = 0 — was rejected
  // as "off screen" and the downward flip was the only survivor. Downward means onto the block's own
  // drawing: measured at 1111px² inside an excalidraw canvas, with NO other affordance in play, so this
  // was never a collision problem. A pill in an island renders on the outer page and may legally sit
  // above the island, so the outermost editor's scroller is what decides visibility.
  const outerScroller = (() => {
    let node: HTMLElement | null = view.scrollDOM;
    for (let hop = view.scrollDOM.parentElement; hop; hop = hop.parentElement) {
      if (hop.classList.contains("cm-scroller")) node = hop; // an ancestor scroller means we are nested
    }
    return node;
  })();
  const bounds = outerScroller.getBoundingClientRect();
  const placed: Placed[] = [];
  for (const { el, r } of candidates) {
    const cur: Placed = { el, top: r.top, bottom: r.bottom, left: r.left, right: r.right, dy: 0, dx: 0 };
    if (el.matches(PINNED)) { placed.push(cur); continue; } // #453: presence is authoritative, never moved

    const step = r.height + GAP;
    // Try the reserved rows ABOVE first (that is where this chrome lives), then SIDEWAYS on the original
    // row, and only then flip BELOW. #577: the flip alone satisfied "nothing overlaps" and "nothing is
    // hidden" while breaking a rule nobody had written down — inside a container the rows above belong to
    // the container's own chrome, so the flip was always taken, and downward lands ON the block's drawing
    // (measured: the pill sat 20px inside an excalidraw canvas). A nested block has no room above but it
    // does have room beside, so the inline candidates come first and the flip stays as the last resort for
    // a column too narrow to hold both.
    const host = el.closest<HTMLElement>(FOCUS_HOSTS);
    const content = host ? host.getBoundingClientRect() : null;
    const slot = chooseSlot({ r, bounds, content, peers: placed, step });
    if (slot) {
      placed.push({ ...cur, top: r.top + slot.dy, bottom: r.bottom + slot.dy, left: r.left + slot.dx, right: r.right + slot.dx, dy: slot.dy, dx: slot.dx });
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
          // exactly one host wears the focus mark; the CSS that used to react to `:hover` reacts to this.
          // A nested slot can be the host, and then NO wrap carries the mark — which is precisely how the
          // container stops showing its own chrome while the caret is in its child (#528).
          for (const w of Array.from(view.dom.querySelectorAll<HTMLElement>(FOCUS_HOSTS))) {
            w.classList.toggle("cm-aff-focus", w === focus);
          }
          // An affordance is shown only if the focused block owns it — placed in the same pass, so there is
          // no frame where it is on screen without the owner having measured it (#528). The chrome row
          // is gated the same way as the pill now: leaving it out is why an unrelated block still presented
          // one (#528— the row's own opacity stayed 1 while only its buttons faded, so it read as a
          // permanent affordance and reserved a slot the owner then routed other chrome around).
          for (const el of Array.from(view.dom.querySelectorAll<HTMLElement>(OWNER_GATED))) {
            el.classList.toggle("cm-aff-shown", focus != null && el.closest(FOCUS_HOSTS) === focus);
          }
          // Write the displacement as a VARIABLE on the editor root, which no widget rebuild touches, so an
          // element CodeMirror re-creates is already placed the moment it appears (#528). Writing the
          // transform onto the element itself lost the placement on every rebuild.
          const root = view.dom;
          for (const p of placed) {
            const name = varFor(p.el);
            if (!name) continue; // presence: pinned, never displaced, has no variable
            const v = `${Math.round(p.dy)}px`;
            if (root.style.getPropertyValue(name) !== v) root.style.setProperty(name, v);
            const nameX = dxVarFor(p.el);
            if (nameX) {
              const vx = `${Math.round(p.dx)}px`;
              if (root.style.getPropertyValue(nameX) !== vx) root.style.setProperty(nameX, vx);
            }
          }
        },
      });
    }
  },
);
