import { StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { MutableRefObject } from "react";
import { headingsExtension, extractHeadings, type Heading } from "./headings";
import { taskProgressExtension, type TaskProgress } from "./task-progress"; // #290: page task-progress ring

// #192 / #319: wire a mounted read-render CM view (mountPublishedView / the editor's live surface) to a
// table of contents. Extracted from Editor.tsx (#319) so the ANONYMOUS public reader drives its TOC from the
// SAME CM heading extension the member view uses — instead of the old DOM-scraping usePublicToc, which can't
// see CM headings (they are CM lines, not <h1> tags). Pure CM wiring (no React component); callers hold the
// React state and pass setters.
//
// #319 SCROLL SEAM: the member view lets the CM view own scrolling (its `.cm-scroller`). The public reader
// scrolls an OUTER container (the frosted band + body sit in one `overflow-y-auto` div, so the sticky band
// frosts the content under it). So `scrollEl` (the element that actually scrolls) and `bandPx` (the sticky
// band's height, for the active-heading sample point + jump landing) are injectable; both default to the CM
// scroller + the content padding-top (the member wiring, unchanged). Returns a cleanup.
export function wireToc(
  view: EditorView,
  opts: {
    onHeadings?: (h: Heading[]) => void;
    onActiveHeading?: (from: number | null) => void;
    // #345the VISIBLE set (light layer) — the headings whose section intersects the viewport judgment
    // band. Reported only when the set changes (diff-apply). The single ACTIVE (dark) heading stays on
    // onActiveHeading. The two layers together are the redesigned Recent-position highlight.
    onVisibleHeadings?: (froms: number[]) => void;
    onScrollActivity?: () => void;
    tocJumpRef?: MutableRefObject<((from: number) => void) | null>;
    onTaskProgress?: (p: TaskProgress) => void;
    scrollEl?: HTMLElement; // the actual scroll container (default: the CM scroller)
    bandPx?: () => number; // the sticky-band height for the sample/landing offset (default: contentDOM padding-top)
  },
): () => void {
  const cleanups: (() => void)[] = [];
  const scrollEl = (): HTMLElement => opts.scrollEl ?? view.scrollDOM;
  const bandPx = (): number => (opts.bandPx ? opts.bandPx() : parseFloat(getComputedStyle(view.contentDOM).paddingTop) || 0);
  if (opts.onHeadings) view.dispatch({ effects: StateEffect.appendConfig.of(headingsExtension(opts.onHeadings)) });
  if (opts.onTaskProgress) view.dispatch({ effects: StateEffect.appendConfig.of(taskProgressExtension(opts.onTaskProgress)) }); // #290
  // #345jump-intent priority. After a TOC click we PIN the clicked heading as the current (dark) one
  // until the user ACTUALLY scrolls (wheel/touch/keyboard). The programmatic jump fires `scroll` events whose
  // recompute would otherwise yank the dark highlight to a neighbour on a short section (theregression).
  let jumpPinned: number | null = null;
  if (opts.tocJumpRef) {
    const ref = opts.tocJumpRef;
    ref.current = (from: number) => {
      const pos = Math.min(from, view.state.doc.length);
      if (opts.scrollEl) {
        // #319: an OUTER scroller (the public reader). CM's own scrollIntoView scrolls its `.cm-scroller`,
        // which here is content-height and never scrolls — so scroll the outer container instead, landing the
        // heading flush under the frosted band (bandPx), mirroring the band-aware member jump.
        const coords = view.coordsAtPos(pos);
        const el = opts.scrollEl;
        if (coords) el.scrollTo({ top: el.scrollTop + coords.top - el.getBoundingClientRect().top - bandPx() - 8, behavior: "smooth" });
      } else {
        // #345: tag the jump as `select.jump` so the #306 scrolloff listener SKIPS it (bandScrollMargins lands
        // the heading under the band; the scrolloff "keep the caret in the band" correction otherwise fights it).
        view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: "start" }), userEvent: "select.jump" });
        if (!view.state.readOnly) view.focus();
      }
      jumpPinned = from; // pin the dark highlight until a real user scroll releases it
      opts.onActiveHeading?.(from); // #304 (3): light the jumped-to heading immediately (scroll recompute converges)
    };
    cleanups.push(() => { ref.current = null; });
  }
  if (opts.onActiveHeading || opts.onVisibleHeadings || opts.onScrollActivity) {
    const reportActive = opts.onActiveHeading;
    const reportVisible = opts.onVisibleHeadings;
    const activity = opts.onScrollActivity;
    let raf = 0;
    let lastVisibleKey = "";
    const compute = () => {
      raf = 0;
      // #192 / #345two sample points (band top, ~80% down) → doc positions via posAtCoords (integer
      // offset comparison against heading `from`s, O(headings), NO per-item coordsAtPos — robust for headings
      // scrolled above the viewport, and works for BOTH scroll seams: the CM scroller and the public outer one).
      const rect = scrollEl().getBoundingClientRect();
      const hs = extractHeadings(view.state);
      const cx = rect.left + rect.width / 2;
      // #345sample near the VIEWPORT BOTTOM (not 80% down) so the visible set covers the WHOLE on-screen
      // area — the old narrow band left only ~1 light item (the "2 layers don't show" report). posAtCoords near
      // the very edge can miss, so nudge in 8px; works for both scroll seams (posAtCoords maps screen y → doc
      // offset for the CM scroller AND the public outer scroller uniformly).
      let topPos = view.posAtCoords({ x: cx, y: rect.top + bandPx() + 8 });
      let botPos = view.posAtCoords({ x: cx, y: rect.top + rect.height - 8 });
      // #345Issue B: when a sample MISSES (the content is shorter than the viewport, so the bottom sample
      // lands below the rendered text; or a tall intro pushes a sample off content), fall back to the doc bounds
      // instead of bailing. The old `topPos != null && botPos != null` guard skipped the visible layer entirely
      // on a miss, and the active layer went null too — the reported "nothing is highlighted".
      if (topPos == null) topPos = 0;
      if (botPos == null) botPos = view.state.doc.length;
      const lo = Math.min(topPos, botPos), hi = Math.max(topPos, botPos);
      // VISIBLE (light): every section [h.from, next.from) intersecting [lo, hi]. Diff-apply.
      const visible: number[] = [];
      for (let i = 0; i < hs.length; i++) {
        const end = i + 1 < hs.length ? hs[i + 1]!.from : view.state.doc.length;
        if (hs[i]!.from <= hi && end >= lo) visible.push(hs[i]!.from);
      }
      if (reportVisible) {
        const key = visible.join(",");
        if (key !== lastVisibleKey) { lastVisibleKey = key; reportVisible(visible); }
      }
      // ACTIVE (dark): the last heading at/above the band-top sample.the bottom clamp (#304-2) is GONE —
      // a short final section is covered by the light layer instead; a jump to it is held by jumpPinned.
      //Issue B fallback: if NO heading sits above the band (a tall intro before the first heading), light
      // the TOPMOST on-screen heading so the reader's section is never unlit while a heading is visible. Only a
      // pure-intro screen (no heading visible at all) stays unlit.
      if (reportActive) {
        let active: number | null = null;
        for (const h of hs) { if (h.from <= topPos) active = h.from; else break; }
        ///never leave the active layer empty while a heading is on screen — fall back to the TOPMOST
        // visible heading (the section the reader is entering). visible is never empty when a heading is on
        // screen, so this covers both a top-intro screen AND the doc bottom. Only a pure-intro screen stays unlit.
        if (active == null && visible.length) active = visible[0]!;
        if (jumpPinned != null) active = jumpPinned; // jump-intent wins until the user scrolls
        reportActive(active);
      }
    };
    const onScroll = () => {
      activity?.(); // #192: drive the narrow-screen TOC overlay's "visible while scrolling"
      if (!raf) raf = requestAnimationFrame(compute);
    };
    // #345a REAL user scroll (wheel / touch / keyboard) releases the jump pin → normal scroll-spy resumes.
    const releasePin = () => { jumpPinned = null; };
    const el = scrollEl();
    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("wheel", releasePin, { passive: true });
    el.addEventListener("touchmove", releasePin, { passive: true });
    el.addEventListener("keydown", releasePin);
    cleanups.push(() => {
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("wheel", releasePin);
      el.removeEventListener("touchmove", releasePin);
      el.removeEventListener("keydown", releasePin);
      if (raf) cancelAnimationFrame(raf);
    });
    raf = requestAnimationFrame(compute); // initial
  }
  return () => cleanups.forEach((c) => c());
}
