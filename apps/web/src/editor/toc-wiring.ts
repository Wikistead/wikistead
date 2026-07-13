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
      opts.onActiveHeading?.(from); // #304 (3): light the jumped-to heading immediately (scroll recompute converges)
    };
    cleanups.push(() => { ref.current = null; });
  }
  if (opts.onActiveHeading || opts.onScrollActivity) {
    const report = opts.onActiveHeading;
    const activity = opts.onScrollActivity;
    let raf = 0;
    const compute = () => {
      raf = 0;
      if (!report) return;
      // #192: find the heading whose section contains the TOP of the viewport (under the band). Resolve the
      // DOC POSITION at the sample point once (posAtCoords) and compare heading doc offsets — robust for
      // headings scrolled ABOVE the viewport (per-heading coordsAtPos returns null there).
      const rect = scrollEl().getBoundingClientRect();
      const hs = extractHeadings(view.state);
      const topPos = view.posAtCoords({ x: rect.left + rect.width / 2, y: rect.top + bandPx() + 8 });
      let active: number | null = null;
      if (topPos != null) {
        for (const h of hs) {
          if (h.from <= topPos) active = h.from; // last heading at/above the viewport top → current section
          else break; // headings are in doc order
        }
      }
      // #304 (2): at the very bottom, a final section shorter than the viewport can never reach the sample
      // line, so its heading would never activate. Clamp: when scrolled to the end, the LAST heading is active.
      const sc = scrollEl();
      if (hs.length && sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 2) active = hs[hs.length - 1].from;
      report(active);
    };
    const onScroll = () => {
      activity?.(); // #192: drive the narrow-screen TOC overlay's "visible while scrolling"
      if (report && !raf) raf = requestAnimationFrame(compute);
    };
    const el = scrollEl();
    el.addEventListener("scroll", onScroll, { passive: true });
    cleanups.push(() => { el.removeEventListener("scroll", onScroll); if (raf) cancelAnimationFrame(raf); });
    if (report) raf = requestAnimationFrame(compute); // initial active
  }
  return () => cleanups.forEach((c) => c());
}
