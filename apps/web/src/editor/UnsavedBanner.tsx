// #813 / ADR-248 §3.2: a band, not a lock (owner ruling).
//
// While the connection is not carrying this client's edits, the surface wears a permanent band that
// says so. It is a BAND rather than a toast because this is a state that continues, not an event that
// happened — a toast that appeared when the socket dropped would be gone by the time the person
// looked up, and they would go on typing.
//
// And it is a band rather than a locked editor because the characters are not lost: they live in the
// local Y.Doc, and the next successful connection merges them. Locking the surface would throw away
// the one thing Yjs is for. What is withheld is publishing — the act that would tell somebody their
// work is safe when it is not.
//
// ⚠️ It sits ABOVE the CodeMirror surface, in the page chrome, never inside the editor's DOM. A widget
// inside the surface enters CodeMirror's height map, and a band that appears and disappears would move
// every line below it — the block-widget motion drift this codebase has measured more than once.
import { useTranslation } from "react-i18next";
import type { NotLiveReason } from "./liveness";

/** The four states, each said in the words that fit what the reader can do about it. */
const KEY: Record<NotLiveReason, string> = {
  connecting: "collab.notSaving.connecting",
  unauthenticated: "collab.notSaving.unauthenticated",
  "read-only": "collab.notSaving.readOnly",
  syncing: "collab.notSaving.syncing",
};

export function UnsavedBanner({ reason }: { reason: NotLiveReason | null }) {
  const { t } = useTranslation();
  if (!reason) return null;
  // The house's existing caution band (AdminAuthTab): a left rule tinted from `--danger`, on the
  // panel background, in dim text. ⚠️ Invented tokens would have shipped an INVISIBLE banner —
  // Tailwind drops a class it cannot resolve, without a word, and the band's whole job is to be seen.
  return (
    <div
      role="status"
      data-testid="not-saving-banner"
      data-reason={reason}
      // #873 (review rejection 2): the title band above (bandRef, routes.tsx) is `position: absolute`
      // with `z-20`, so this banner — a normal-flow sibling with no positioning of its own — painted
      // BELOW it regardless of DOM order (an absolutely-positioned, z-indexed element always paints
      // over static in-flow content). The band overlays the top of the scroller rather than pushing it
      // down, so this banner rendered right where the band sits, hidden under its frosted layer.
      //
      // ⚠️ Not fixed by moving the banner INSIDE the band: the band's height is published as
      // `--wks-band-h` by a ResizeObserver the editor's own top padding reads (routes.tsx), so folding
      // the banner into that box would make the TITLE band itself grow and shrink every time
      // connectivity flips — the band-height churn ADR-248 §3.2 was written to avoid. Pushing this
      // element down by the band's own published height, as a plain sibling AFTER it, keeps the two
      // independent: the title band's height never depends on liveness, and this banner simply clears
      // whatever height the band currently publishes.
      style={{ marginTop: "var(--wks-band-h, 0px)" }}
      // #873 (review rejection): the class alone got the strip's DEFAULT, `var(--accent)` — blue. The
      // border beside it was already `--danger`, so the band read as ordinary information while its
      // border said otherwise. ⚠️ A mistyped token would have been visible (Tailwind drops what it
      // cannot resolve and the strip disappears); an unstated one is not, because the default paints
      // something plausible. Every other wks-left-bar site names its colour for this reason.
      className="wks-left-bar mx-3 mb-2 rounded-lg border border-[color-mix(in_srgb,var(--danger)_40%,var(--border))] px-3 py-2.5 text-xs text-fg-dim [--wks-left-bar-color:var(--danger)] [--wks-left-bar-pad:0.75rem]"
    >
      <strong className="font-medium">{t("collab.notSaving.title")}</strong>{" "}
      {t(KEY[reason])}
    </div>
  );
}
