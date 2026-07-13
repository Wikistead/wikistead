import { Toc } from "./Toc";
import type { Heading } from "../editor/headings";

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
  visibleFroms?: number[]; // #345the light-layer visible set (rail only)
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
  if (headings.length === 0) return null;
  // (#227①: the old public-only floating toggle was removed — every surface hosts the toggle in
  // the shared PageStatus ToggleButton, so member and public are the same UI.)
  return (
    <>
      {isWide && tocOn && railEnabled && (
        // #212 bounce 3: clear the absolute header band (offset top by --wks-band-h) so the rail isn't hidden.
        // #304 (4): elastic width — grow into the right whitespace instead of a fixed 210px (which truncated
        // items even with room to spare), clamped so it never collides with the reading column or overruns.
        <div
          className="pointer-events-none absolute bottom-2 z-[5]"
          style={{ left: railLeft, top: railTop, width: "clamp(210px, calc(50vw - 370px - 2rem), 300px)" }}
        >
          <div className="pointer-events-auto h-full">
            <Toc headings={headings} activeFrom={activeFrom} visibleFroms={visibleFroms} depth={depth} onJump={onJump} variant="rail" />
          </div>
        </div>
      )}
      {!isWide && tocOn && (
        <Toc headings={headings} activeFrom={activeFrom} depth={depth} onJump={onJump} variant="overlay" subscribeScroll={subscribeScroll} />
      )}
    </>
  );
}
