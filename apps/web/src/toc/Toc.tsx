import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../lib/utils";
import type { Heading } from "../editor/headings";

// #192 / ADR-091 (revised): the table-of-contents. Derived, display-only (headings come from the
// editor; clicking jumps via onJump; the active item follows scroll). Two presentations:
//  - "rail" (wide screens): ALWAYS shown to the right of the content, BLENDED into the background —
//    no panel box, no border; only the current section is highlighted, the rest is subdued.
//  - "overlay" (narrow screens): a blurred overlay OVER the content, shown ONLY WHILE scrolling and
//    fading out shortly after scrolling stops (driven by subscribeScroll).
// Depth (H1 / H1–H3 / all) and on/off are set in Settings → Editor now, not in the rail itself, so
// the TOC stays clean (the depth just filters the list here).
export function Toc({
  headings, activeFrom, visibleFroms, depth, onJump, variant = "rail", subscribeScroll, rightPanelOpen = false,
}: {
  headings: Heading[];
  activeFrom: number | null;
  // #345the two-layer highlight — `activeFrom` is the single CURRENT heading (dark, accent), while
  // `visibleFroms` are the headings whose section is on screen (light, a subtle wash). A short final section
  // that the sample point can't reach is still lit (light) by the visible layer.
  visibleFroms?: number[];
  depth: number;
  onJump: (from: number) => void;
  variant?: "rail" | "overlay";
  subscribeScroll?: (fn: () => void) => () => void;
  // #515: the OVERLAY variant is `fixed right-3` — the same right edge a side panel (comments/related/
  // history) opens on. When a right panel is open the overlay SHIFTS LEFT by the panel width so both stay
  // visible side by side (user ruling: keep the TOC, don't hide it); it returns to right-3 when the panel
  // closes. The rail variant sits in the left/center whitespace and never collides, so this only shifts the
  // overlay.
  rightPanelOpen?: boolean;
}) {
  const { t } = useTranslation();
  const shown = headings.filter((h) => h.level <= depth);
  const minLevel = shown.length ? Math.min(...shown.map((h) => h.level)) : 1;
  const visible = useMemo(() => new Set(visibleFroms ?? []), [visibleFroms]);
  // #345auto-follow keeps the whole highlighted RUN (active + the light "visible" items) PLUS a couple
  // of neighbours in view as the reader scrolls a long TOC — a scrolloff band for the table of contents, so the
  // highlight never scrolls out of the rail/overlay (the old single-active centring let it fall off at the
  // bottom). Both variants follow now (the overlay is max-h/overflow-y-auto too,Issue 3).REGRESSION
  // GUARD: scroll ONLY nav.scrollTop, never an ancestor (Element.scrollIntoView hijacked the content scroller).
  const navRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const nav = navRef.current;
    if (!nav || nav.scrollHeight <= nav.clientHeight) return; // short TOC (fits) → nothing to follow
    const items = Array.from(nav.querySelectorAll<HTMLElement>("[data-testid=toc-item]"));
    const hi = items.filter((el) => el.hasAttribute("data-active") || el.hasAttribute("data-visible"));
    if (hi.length === 0) return;
    const navRect = nav.getBoundingClientRect();
    const offTop = (el: HTMLElement) => el.getBoundingClientRect().top - navRect.top + nav.scrollTop;
    const rowH = hi[0]!.getBoundingClientRect().height || 24;
    const margin = rowH * 2; // keep ~2 neighbours visible on each side of the highlighted run (the scrolloff band)
    const runTop = offTop(hi[0]!) - margin;
    const last = hi[hi.length - 1]!;
    const runBottom = offTop(last) + last.getBoundingClientRect().height + margin;
    const viewTop = nav.scrollTop, viewBottom = nav.scrollTop + nav.clientHeight;
    let next = nav.scrollTop;
    if (runBottom - runTop >= nav.clientHeight) {
      // the run + margins is taller than the nav → centre the active item (or the run's start) instead
      const active = items.find((el) => el.hasAttribute("data-active")) ?? hi[0]!;
      next = offTop(active) - nav.clientHeight / 2 + active.getBoundingClientRect().height / 2;
    } else if (runTop < viewTop) {
      next = runTop; // run (with its top margin) sits above the view → scroll up to reveal it
    } else if (runBottom > viewBottom) {
      next = runBottom - nav.clientHeight; // run (with its bottom margin) sits below → scroll down to reveal it
    }
    nav.scrollTop = Math.max(0, Math.min(next, nav.scrollHeight - nav.clientHeight));
  }, [activeFrom, visibleFroms]);

  // Overlay visibility: each scroll shows it and resets a fade timer; it hides ~1.2s after scrolling
  // stops. setScrolling(true) during a continuous scroll is a no-op re-render (React bails on an
  // unchanged value), so this costs a render only on the show/hide transitions.
  const [scrolling, setScrolling] = useState(false);
  // #345Issue 3: while the pointer is OVER the overlay, hold it open (cancel the fade) so the reader can
  // read/scroll the TOC instead of it fading out from under them.
  const [hovered, setHovered] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  // #192: the overlay must clear the top-right floating control band (the TOC + comments toggles,
  // data-testid="page-status") with ZERO overlap. A calc() guess kept under-shooting the real bottom,
  // so MEASURE the band's actual bottom (getBoundingClientRect) and start the overlay just below it —
  // self-correcting as the band's height / button count changes.
  const [overlayTop, setOverlayTop] = useState(112);
  useEffect(() => {
    if (variant !== "overlay") return;
    const measure = () => {
      const band = document.querySelector('[data-testid="page-status"]');
      if (band) setOverlayTop(Math.ceil(band.getBoundingClientRect().bottom) + 12);
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [variant, scrolling]); // re-measure when it (re)appears — the band may have moved/resized
  useEffect(() => {
    if (variant !== "overlay" || !subscribeScroll) return;
    return subscribeScroll(() => {
      setScrolling(true);
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setScrolling(false), 1200);
    });
  }, [variant, subscribeScroll]);
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);

  if (shown.length === 0) return null; // no headings → no rail/overlay clutter

  // #345Issue C: draw a CONSECUTIVE run of highlighted items (visible and/or active) as ONE smooth
  // shape instead of a stack of separate rounded rectangles. A highlighted row rounds its top only when the row
  // ABOVE isn't highlighted, and its bottom only when the row BELOW isn't — so a run reads as a single pill with
  // rounded ends and seamless middles, while each row keeps its own tier colour (idle < visible < active).
  const isHi = (i: number): boolean => visible.has(shown[i]!.from) || activeFrom === shown[i]!.from;
  const list = (
    <ul className="m-0 list-none p-0">
      {shown.map((h, i) => {
        const hi = isHi(i);
        const roundTop = hi && !(i > 0 && isHi(i - 1));
        const roundBottom = hi && !(i < shown.length - 1 && isHi(i + 1));
        return (
          <li key={h.slug}>
            <button
              type="button"
              onClick={() => onJump(h.from)}
              data-testid="toc-item"
              data-active={activeFrom === h.from ? "" : undefined}
              data-visible={visible.has(h.from) ? "" : undefined}
              style={{ paddingLeft: `${6 + (h.level - minLevel) * 12}px` }}
              className={cn(
                "block w-full cursor-pointer truncate py-1 pr-2 text-left text-[length:var(--text-xs)] text-fg-dim transition-colors duration-[120ms] hover:text-foreground",
                // #345round only the ENDS of a highlighted run so consecutive rows merge into one shape.
                roundTop && "rounded-t",
                roundBottom && "rounded-b",
                // #345/LIGHT layer — a section on screen but not the current one.measured that
                // the old `text-foreground/80` was grey-vs-grey with idle `text-fg-dim` (imperceptible). Make three
                // legible tiers: idle (fg-dim) < visible (FULL foreground + a faint NEUTRAL wash) < active (accent
                // text + accent wash). The neutral wash reads clearly against idle without competing with active.
                visible.has(h.from) && activeFrom !== h.from && "text-foreground bg-[color-mix(in_srgb,var(--fg)_8%,transparent)]",
                // #192 / #345: DARK layer — the single active heading: accent text PLUS a faint accent-tinted
                // background wash on the whole row (low opacity via color-mix), so the current section stands out.
                activeFrom === h.from && "font-medium text-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_14%,transparent)]",
              )}
              data-tip={h.text}
            >{h.text || t("common.untitled")}</button>
          </li>
        );
      })}
    </ul>
  );

  if (variant === "overlay") {
    return (
      <nav
        ref={navRef}
        aria-label={t("toc.title")}
        data-testid="toc"
        data-variant="overlay"
        style={{ top: `${overlayTop}px` }}
        // #345Issue 3: hovering the overlay holds it open (cancels the fade) so it can be read/scrolled.
        onMouseEnter={() => { if (timer.current) window.clearTimeout(timer.current); setHovered(true); }}
        onMouseLeave={() => { setHovered(false); if (timer.current) window.clearTimeout(timer.current); timer.current = window.setTimeout(() => setScrolling(false), 1200); }}
        className={cn(
          // #192: `top` is the MEASURED bottom of the control band (see overlayTop) so the overlay never
          // overlaps the TOC/comments buttons. Glass look: translucent panel + backdrop-blur.
          "fixed z-30 max-h-[70vh] w-[240px] overflow-y-auto rounded-lg border border-border/60 bg-panel/70 p-3 shadow-lg backdrop-blur-md transition-opacity duration-200",
          // #515 rev (user ruling): while a right panel is open, don't HIDE the overlay — SHIFT it LEFT by the
          // panel width (RightPanel md:w-[320px]) so both stay visible side by side; back to right-3 when closed.
          rightPanelOpen ? "right-[calc(0.75rem+320px)]" : "right-3",
          scrolling || hovered ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0",
        )}
      >
        {list}
      </nav>
    );
  }
  // rail: blends into the background — no panel bg, no border; the active item is the only accent.
  // #345Issue 4: py-2 (was py-4) so the rail uses more of its vertical space for the list.
  return (
    <nav
      ref={navRef}
      aria-label={t("toc.title")}
      data-testid="toc"
      data-variant="rail"
      className="flex h-full min-h-0 w-full flex-col overflow-y-auto bg-transparent px-3 py-2 text-[length:var(--text-ui)]"
    >
      {list}
    </nav>
  );
}
