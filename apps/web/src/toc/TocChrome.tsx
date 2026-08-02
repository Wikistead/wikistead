import { useEffect, useRef, useState } from "react";
import { Toc } from "./Toc";
import type { Heading } from "../editor/headings";

// #593: the rail's geometry, in ONE reference frame.
//
// It used to place itself against its PARENT (`left: calc(50% + 370px + 1rem)`, where the parent starts
// 260px in, past the sidebar) and size itself against the VIEWPORT (`50vw`). Both expressions mean to
// say "the gutter right of the reading column", and only one of them knows the sidebar is there — so the
// width came out half a sidebar too big and the rail hung off the screen (measured: +126px at 1200,
// +96px at 1440, with item text cut mid-word).
//
// Everything below is parent-relative, and the same numbers decide whether the rail appears at all: the
// old `isWide` test asked the viewport, so a window with a sidebar open could be "wide" while the actual
// gutter was 84px. `clamp`'s 210px floor then guaranteed an overflow instead of a fallback.
const COLUMN_HALF = 370; // half the reading column
const RAIL_GAP = 32; // 1rem beside the column + 1rem before the edge
const RAIL_MIN = 210;
const RAIL_MAX = 300;

/** The gutter this rail would occupy, from the container it is positioned in. */
export const railGutter = (containerWidth: number): number => containerWidth / 2 - COLUMN_HALF - RAIL_GAP;
/** Whether the rail fits — the question the viewport media query could not answer. */
export const railFitsIn = (containerWidth: number): boolean => railGutter(containerWidth) >= RAIL_MIN;

// The shared TOC chrome: the rail (wide) + overlay (narrow) variant switching, and an optional floating
// on/off toggle. Every surface that shows a table of contents renders THIS — the member page views and the
// anonymous public reader (#227) — so the public reader stops re-implementing the wiring. #319: BOTH surfaces
// now source their headings from the SAME CM heading extension via `wireToc` (the public reader renders with
// mountPublishedView too); the presentation/variant-switching is one component. Presentation only; no fetching.
export function TocChrome({
  headings,
  activeFrom,
  visibleFroms,
  depth,
  onJump,
  subscribeScroll,
  isWide,
  tocOn,
  railEnabled = true,
  railLeft = "calc(50% + 370px + 1rem)",
  railTop = "calc(var(--wks-band-h, 0px) + 0.5rem)",
}: {
  headings: Heading[];
  activeFrom: number | null;
  visibleFroms?: number[]; // #345/the light-layer visible set (both rail and overlay)
  depth: number;
  onJump: (from: number) => void;
  subscribeScroll?: (fn: () => void) => () => void;
  isWide: boolean;
  tocOn: boolean;
  // Members suppress the wide rail while a right panel (comments/history/…) occupies the same zone.
  railEnabled?: boolean;
  railLeft?: string;
  railTop?: string;
}) {
  // measured, not assumed: the container is what the rail is positioned against, and it changes when the
  // sidebar opens or closes without the viewport moving at all
  const probe = useRef<HTMLSpanElement | null>(null);
  const [fits, setFits] = useState(false);
  useEffect(() => {
    const host = probe.current?.parentElement;
    if (!host) return;
    const read = () => setFits(railFitsIn(host.getBoundingClientRect().width));
    read();
    const ro = new ResizeObserver(read);
    ro.observe(host);
    return () => ro.disconnect();
  }, [headings.length, isWide, tocOn, railEnabled]);
  if (headings.length === 0) return null;
  // (#227①: the old public-only floating toggle was removed — every surface hosts the toggle in
  // the shared PageStatus ToggleButton, so member and public are the same UI.)
  return (
    <>
      <span ref={probe} className="pointer-events-none absolute h-0 w-0" aria-hidden data-testid="toc-rail-probe" />
      {isWide && tocOn && railEnabled && fits && (
        // #212 bounce 3: clear the absolute header band (offset top by --wks-band-h) so the rail isn't hidden.
        // #304 (4): elastic width — grow into the right whitespace instead of a fixed 210px (which truncated
        // items even with room to spare), clamped so it never collides with the reading column or overruns.
        <div
          data-print-hide
          className="pointer-events-none absolute bottom-2 z-[5]"
          data-testid="toc-rail"
          // parent-relative, like `left` — a `vw` here is what put the rail off screen (#593)
          style={{ left: railLeft, top: railTop, width: `clamp(${RAIL_MIN}px, calc(50% - ${COLUMN_HALF}px - ${RAIL_GAP}px), ${RAIL_MAX}px)` }}
        >
          <div className="pointer-events-auto h-full">
            <Toc headings={headings} activeFrom={activeFrom} visibleFroms={visibleFroms} depth={depth} onJump={onJump} variant="rail" />
          </div>
        </div>
      )}
      {(!isWide || !fits) && tocOn && (
        // #345Issue A: the overlay gets the two-layer highlight too (was rail-only). Presentation is
        // variant-independent; auto-follow stays rail-only (the overlay is pointer-events-none).
        <Toc headings={headings} activeFrom={activeFrom} visibleFroms={visibleFroms} depth={depth} onJump={onJump} variant="overlay" subscribeScroll={subscribeScroll} rightPanelOpen={!railEnabled} />
      )}
    </>
  );
}
