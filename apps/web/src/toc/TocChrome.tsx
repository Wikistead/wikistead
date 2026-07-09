import { List } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Toc } from "./Toc";
import type { Heading } from "../editor/headings";

// The shared TOC chrome: the rail (wide) + overlay (narrow) variant switching, and an optional floating
// on/off toggle. Every surface that shows a table of contents renders THIS — the member page views and the
// anonymous public reader (#227) — so the public reader stops re-implementing the wiring. Only the heading
// SOURCE differs per caller (the editor's heading extension for members; usePublicToc, from the rendered DOM,
// for the public reader); the presentation/variant-switching is one component. Presentation only; no fetching.
export function TocChrome({
  headings,
  activeFrom,
  depth,
  onJump,
  subscribeScroll,
  isWide,
  tocOn,
  onToggle,
  railEnabled = true,
  railLeft = "calc(50% + 370px + 1rem)",
  railTop = "calc(var(--wks-band-h, 0px) + 0.5rem)",
}: {
  headings: Heading[];
  activeFrom: number | null;
  depth: number;
  onJump: (from: number) => void;
  subscribeScroll?: (fn: () => void) => () => void;
  isWide: boolean;
  tocOn: boolean;
  // A floating on/off toggle (the public reader has no controls bar to host one). Members omit it — their
  // toggle lives in the page controls bar and flips the same device-local pref.
  onToggle?: () => void;
  // Members suppress the wide rail while a right panel (comments/history/…) occupies the same zone.
  railEnabled?: boolean;
  railLeft?: string;
  railTop?: string;
}) {
  const { t } = useTranslation();
  if (headings.length === 0) return null;
  return (
    <>
      {onToggle && (
        <button
          type="button"
          data-testid="toc-toggle"
          aria-pressed={tocOn}
          aria-label={t("toc.toggle")}
          title={t("toc.toggle")}
          onClick={onToggle}
          className={`absolute right-3 top-[calc(var(--wks-band-h,5.5rem)+0.5rem)] z-10 rounded p-1.5 ${tocOn ? "bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] text-[var(--accent)]" : "text-fg-dim hover:bg-panel-2"}`}
        >
          <List size={16} />
        </button>
      )}
      {isWide && tocOn && railEnabled && (
        // #212 bounce 3: clear the absolute header band (offset top by --wks-band-h) so the rail isn't hidden.
        // #304 (4): elastic width — grow into the right whitespace instead of a fixed 210px (which truncated
        // items even with room to spare), clamped so it never collides with the reading column or overruns.
        <div
          className="pointer-events-none absolute bottom-2 z-[5]"
          style={{ left: railLeft, top: railTop, width: "clamp(210px, calc(50vw - 370px - 2rem), 300px)" }}
        >
          <div className="pointer-events-auto h-full">
            <Toc headings={headings} activeFrom={activeFrom} depth={depth} onJump={onJump} variant="rail" />
          </div>
        </div>
      )}
      {!isWide && tocOn && (
        <Toc headings={headings} activeFrom={activeFrom} depth={depth} onJump={onJump} variant="overlay" subscribeScroll={subscribeScroll} />
      )}
    </>
  );
}
