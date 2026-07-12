import type { DirectiveMacro } from "./registry";
import { transcludeHtmlRender } from "@wikistead/macro-render"; // #85: export htmlRender is shared, single source
import i18n from "../../i18n"; // #174 comment 911: empty-state text localized (en/ja)

// :::embed-page — embed another page's content by id (the body is the target page id). The MACRO
// never fetches: its host-API is {theme} only (ADR-024 trust boundary). The host (live-preview
// MacroWidget, #108) resolves the referenced page's published markdown via the gated server route
// which re-checks `view` on the REFERENCED page itself (the host page's view is NOT enough), so an
// embed can never reveal a page the viewer can't see; an unviewable/absent ref renders an identical
// placeholder. Source is canonical (`:::embed-page\n<pageId>\n:::` round-trips — Open formats).
// revealOnCursor: the caret inside reveals the raw block so the id is editable in place.
// #205: renamed `:::transclude` → `:::embed-page` (pre-launch, no alias) so the `embed-<what>` naming
// namespaces future embed macros (`:::embed` external content, a later `:::embed-video`, …).
export const transcludeMacro: DirectiveMacro = {
  kind: "directive",
  name: "embed-page",
  exportFidelity: "preserve", // ::: stays plain text → lossless round-trip
  revealOnCursor: true, // Ctrl+Enter reveals the raw block so the id is editable in place
  // #332: an empty caret SELECTS the atom (rendered card + ring) rather than revealing raw — the id is
  // a completed pick, edited via the ⇆ retarget button or Ctrl+Enter, so there is nothing to type in
  // place. (Fixes the picker leaving the caret stranded on a blank line in vim insert mode.)
  atomSelectable: true,
  liveRender: (body) => {
    const el = document.createElement("div");
    el.className = "cm-lp-macro cm-lp-embed-page";
    el.setAttribute("data-testid", "macro-embed-page");
    el.textContent = body.trim() ? "…" : i18n.t("macro.pageEmbedEmpty"); // host swaps in resolved content
    return el;
  },
  // SSR/export placeholder: the server render pipeline resolves the embed; this is the wrapper
  // carrying the target id. XSS-safe (id escaped; no innerHTML of untrusted text).
  htmlRender: transcludeHtmlRender,
  // #205: user-facing name is "embed a page"; keywords lead with embed + JP so the slash
  // palette finds it (transclude kept as a keyword for discoverability, not the syntax).
  slash: { labelKey: "palette.transclude", keywords: "embed page 埋め込み 埋込 transclude include reference link", insert: ":::embed-page\n\n:::", caret: 14 },
};
