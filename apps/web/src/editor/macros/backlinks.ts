import type { DirectiveMacro } from "./registry";
import { html } from "@wikistead/macro-render";

// :::backlinks — an in-body list of the pages that link HERE (#307 / ADR-127), rendering NOTHING when there
// are none. The MACRO never fetches: its host-API is {theme} only (ADR-024 trust boundary). The host
// (live-preview MacroWidget, #307) resolves this page's view-authorized backlinks via the gated
// `GET /pages/:id/backlinks` (#230) — which FGA-view-confirms every source for the caller, so an unviewable
// source is absent from list AND count (no new permission surface, #244 preserved) — and swaps the list in,
// or collapses to nothing (read surface) / a dim placeholder (edit surface) when empty. #307 / the
// body gives the TARGET — empty ⇒ THIS page's backlinks (the default); exactly one non-empty line ⇒ that
// page's id (a hub aggregating another page's backlinks, same convention as `:::embed-page`); anything else ⇒
// rendered as 0 results. A non-viewable/absent target id renders nothing (the endpoint 404s uniformly
// existence-hiding). The list is display output, never written into the source (Open formats: the directive
// round-trips). An optional `[label]` renders only alongside a non-empty list.
export const backlinksMacro: DirectiveMacro = {
  kind: "directive",
  name: "backlinks",
  // The list is derived, never content — export drops it and loses nothing the source owns; the literal
  // `:::backlinks` still round-trips in the Markdown export (§6).
  exportFidelity: "degrade",
  revealOnCursor: true, // Ctrl+Enter / caret-in reveals the raw `:::backlinks` source (atom, ADR-024)
  liveRender: () => {
    // Placeholder only — the HOST swaps in the resolved list, or collapses/placeholders when empty. Loading
    // shows nothing (no skeleton). Empty element (near-zero height) so a page with backlinks disabled (no
    // host resolver, e.g. a template preview) shows nothing rather than a broken box.
    const el = document.createElement("div");
    el.className = "cm-lp-macro cm-lp-backlinks-placeholder";
    el.setAttribute("data-testid", "macro-backlinks-placeholder");
    return el;
  },
  // Type-contract stub only: the web registry REQUIRES an htmlRender, but the SERVER export deliberately does
  // NOT register backlinks (builtinDirectiveDescriptors), so the published/print/HTML path takes the
  // unregistered-directive fallback (an empty `<div class="wks-directive">` with fences + `[label]` stripped)
  // — that IS the v1 "emits nothing" mechanism (§5/§6). This stub is never called on the server.
  htmlRender: () => html``,
  slash: { labelKey: "palette.backlinks", keywords: "backlinks related pages links here 関連 被リンク バックリンク リンク元", insert: ":::backlinks\n\n:::", caret: 12 },
};
