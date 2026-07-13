import type { DirectiveMacro } from "./registry";
import { html } from "@wikistead/macro-render";

// :::query — an in-body, read-only DYNAMIC LIST of pages matching a query (#324 / ADR-134), rendering NOTHING
// when there are none. The body's first non-empty line is the query spec
// - `backlinks` → the pages that link HERE (a tag page's members, when this IS a tag page).
// - `tag <pageId>` → the pages that link to <pageId> (surface another tag page's members from a hub page).
// - `children` → the direct child pages of THIS page.
// Like :::backlinks (ADR-127), the MACRO never fetches: its host-API is {theme} only (ADR-024 trust boundary).
// The host (live-preview MacroWidget) resolves the VIEWER-authorized list via the member-only, view-filtered
// `GET /pages/:id/query?spec=...` (ADR-134 §3 — every result FGA-view-confirmed, an unviewable page absent from
// list AND count) and swaps it in, or collapses to nothing (read surface) / a dim placeholder (edit surface)
// when empty. The list is display output, NEVER written into the source (Open formats: the directive
// round-trips; export degrades to a static Markdown snapshot, §2). On an anonymous/public surface the host
// resolver is ABSENT (member-only, Hole A rev2), so `:::query` renders nothing there until the ②b snapshot.
export const queryMacro: DirectiveMacro = {
  kind: "directive",
  name: "query",
  // The list is derived, never content — export drops the live list (the literal `:::query` round-trips in the
  // Markdown; a static snapshot is the ②b follow-up). exportFidelity: degrade, meaning-preserving.
  exportFidelity: "degrade",
  revealOnCursor: true, // Ctrl+Enter / caret-in reveals the raw `:::query` source (atom, ADR-024)
  liveRender: () => {
    // Placeholder only — the HOST swaps in the resolved list, or collapses/placeholders when empty. Loading
    // shows nothing (no skeleton). Empty element (near-zero height) so a surface with no host resolver (guest
    // / template preview) shows nothing rather than a broken box.
    const el = document.createElement("div");
    el.className = "cm-lp-macro cm-lp-query-placeholder";
    el.setAttribute("data-testid", "macro-query-placeholder");
    return el;
  },
  // Type-contract stub only: the web registry REQUIRES an htmlRender, but the SERVER export deliberately does
  // NOT register query (builtinDirectiveDescriptors), so the published/print/HTML path takes the
  // unregistered-directive fallback (fences stripped) — the v1 "emits nothing off-platform" mechanism. This
  // stub is never called on the server.
  htmlRender: () => html``,
  slash: { labelKey: "palette.query", keywords: "query list tag children backlinks dynamic クエリ 一覧 タグ 子ページ 動的", insert: ":::query\nbacklinks\n:::", caret: 9 },
};
