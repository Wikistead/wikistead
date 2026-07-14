import type { DirectiveMacro } from "./registry";
import { html } from "@wikistead/macro-render";

// :::tagged — an in-body, read-only DYNAMIC LIST of the pages whose frontmatter `tags` include the tag
// named by the body's first non-empty line (#370 / ADR-145; replaces ADR-134's `:::query`). Tags are
// STRINGS (case-insensitive) — no raw page ids, no picker. Renders NOTHING when there are none.
// The MACRO never fetches: its host-API is {theme} only (ADR-024 trust boundary). The host (live-preview
// MacroWidget) resolves the VIEWER-authorized list via the member-only, view-filtered
// `GET /pages/:id/list?name=tagged&body=…` (ADR-145 §4 — every result FGA-view-confirmed, an unviewable
// page absent from list AND count) and swaps it in, or collapses to nothing (read surface) / a dim
// placeholder (edit surface) when empty. The list is display output, NEVER written into the source (Open
// formats: the directive round-trips; the public/guest surface renders the publish-time anonymous
// snapshot baked server-side). On an anonymous surface the host resolver is ABSENT (member-only).
export const taggedMacro: DirectiveMacro = {
  kind: "directive",
  name: "tagged",
  // The list is derived, never content — export degrades to the baked static snapshot (meaning-preserving).
  exportFidelity: "degrade",
  revealOnCursor: true, // Ctrl+Enter / caret-in reveals the raw `:::tagged` source (atom, ADR-024)
  liveRender: () => {
    // Placeholder only — the HOST swaps in the resolved list, or collapses/placeholders when empty.
    const el = document.createElement("div");
    el.className = "cm-lp-macro cm-lp-query-placeholder";
    el.setAttribute("data-testid", "macro-tagged-placeholder");
    return el;
  },
  // Type-contract stub only: the SERVER export deliberately does NOT register tagged
  // (builtinDirectiveDescriptors), so the published/print/HTML path takes the unregistered-directive
  // fallback — the public surface substitutes the baked snapshot BEFORE render. Never called on the server.
  htmlRender: () => html``,
  slash: { labelKey: "palette.tagged", keywords: "tagged tag list pages dynamic タグ 一覧 動的", insert: ":::tagged\n\n:::", caret: 10 },
};
