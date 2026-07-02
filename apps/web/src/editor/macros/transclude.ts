import type { DirectiveMacro } from "./registry";
import { html } from "./safe-html";

// :::transclude — embed another page's content by id (the body is the target page id). The MACRO
// never fetches: its host-API is {theme} only (ADR-024 trust boundary). The host (live-preview
// MacroWidget, #108) resolves the referenced page's published markdown via the gated server route —
// which re-checks `view` on the REFERENCED page itself (the host page's view is NOT enough), so a
// transclude can never reveal a page the viewer can't see; an unviewable/absent ref renders an
// identical placeholder. Source is canonical (`:::transclude\n<pageId>\n:::` round-trips — Open
// formats). revealOnCursor: the caret inside reveals the raw block so the id is editable in place.
export const transcludeMacro: DirectiveMacro = {
  kind: "directive",
  name: "transclude",
  exportFidelity: "preserve", // ::: stays plain text → lossless round-trip
  revealOnCursor: true, // edit the target id by placing the caret inside (like layout directives)
  liveRender: (body) => {
    const el = document.createElement("div");
    el.className = "cm-lp-macro cm-lp-transclude";
    el.setAttribute("data-testid", "macro-transclude");
    el.textContent = body.trim() ? "…" : "Empty transclude — add a page id"; // host swaps in resolved content
    return el;
  },
  // SSR/export placeholder: the server render pipeline resolves the transclusion; this is the
  // wrapper carrying the target id. XSS-safe (id escaped; no innerHTML of untrusted text).
  htmlRender: (body) => html`<div class="transclude" data-page="${body.trim()}"></div>`,
  slash: { labelKey: "palette.transclude", keywords: "transclude embed include page reference link", insert: ":::transclude\n\n:::", caret: 14 },
};
