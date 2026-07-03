import { useEffect, useRef, useState } from "react";
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
  headings, activeFrom, depth, onJump, variant = "rail", subscribeScroll,
}: {
  headings: Heading[];
  activeFrom: number | null;
  depth: number;
  onJump: (from: number) => void;
  variant?: "rail" | "overlay";
  subscribeScroll?: (fn: () => void) => () => void;
}) {
  const { t } = useTranslation();
  const shown = headings.filter((h) => h.level <= depth);
  const minLevel = shown.length ? Math.min(...shown.map((h) => h.level)) : 1;

  // Overlay visibility: each scroll shows it and resets a fade timer; it hides ~1.2s after scrolling
  // stops. setScrolling(true) during a continuous scroll is a no-op re-render (React bails on an
  // unchanged value), so this costs a render only on the show/hide transitions.
  const [scrolling, setScrolling] = useState(false);
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

  const list = (
    <ul className="m-0 list-none p-0">
      {shown.map((h) => (
        <li key={h.slug}>
          <button
            type="button"
            onClick={() => onJump(h.from)}
            data-testid="toc-item"
            data-active={activeFrom === h.from ? "" : undefined}
            style={{ paddingLeft: `${6 + (h.level - minLevel) * 12}px` }}
            className={cn(
              "block w-full cursor-pointer truncate rounded py-1 pr-2 text-left text-[length:var(--text-xs)] text-fg-dim transition-colors duration-[120ms] hover:text-foreground",
              // #192: the active heading — accent text PLUS a faint accent-tinted background wash on the
              // whole row (low opacity via color-mix), so the current section reads at a glance.
              activeFrom === h.from && "font-medium text-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_14%,transparent)]",
            )}
            title={h.text}
          >{h.text || t("common.untitled")}</button>
        </li>
      ))}
    </ul>
  );

  if (variant === "overlay") {
    return (
      <nav
        aria-label={t("toc.title")}
        data-testid="toc"
        data-variant="overlay"
        style={{ top: `${overlayTop}px` }}
        className={cn(
          // #192: `top` is the MEASURED bottom of the control band (see overlayTop) so the overlay never
          // overlaps the TOC/comments buttons. Glass look: translucent panel + backdrop-blur.
          "pointer-events-none fixed right-3 z-30 max-h-[70vh] w-[240px] overflow-y-auto rounded-lg border border-border/60 bg-panel/70 p-3 shadow-lg backdrop-blur-md transition-opacity duration-200",
          scrolling ? "pointer-events-auto opacity-100" : "opacity-0",
        )}
      >
        {list}
      </nav>
    );
  }
  // rail: blends into the background — no panel bg, no border; the active item is the only accent.
  return (
    <nav
      aria-label={t("toc.title")}
      data-testid="toc"
      data-variant="rail"
      className="flex h-full min-h-0 w-full flex-col overflow-y-auto bg-transparent px-3 py-4 text-[length:var(--text-ui)]"
    >
      {list}
    </nav>
  );
}
