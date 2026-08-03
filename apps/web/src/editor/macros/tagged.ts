import type { DirectiveMacro } from "./registry";
import { html } from "@wikistead/macro-render";
import { macroPlaceholder } from "./placeholder"; // #600: one template for every "cannot show it" state

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
  capabilities: ["host-list"], // #450 slice 5c: the host resolves the list; the macro only asks for the slot
  liveRender: (body, ctx) => {
    // #450 slice 5c: ONE resolution path. The host used to spot this macro BY NAME at two different
    // sinks (the CM widget and the nested renderer) and fill it in — two lifecycles for one question,
    // which is how the nested copy came to sit at its placeholder forever. Now the macro asks and the
    // host answers; there is nothing left to keep in step.
    const slot = ctx?.hostSlot?.({ kind: "list", source: "tagged", query: body });
    if (slot) return slot;
    // No host slot on this surface (export, hover card, anonymous): the placeholder, exactly as before.
    const el = document.createElement("div");
    el.className = "cm-lp-macro cm-lp-query-placeholder";
    // #600: this branch rendered an EMPTY div, so a surface with no list host showed a block of zero
    // height. Nothing to click, nothing to read, no way to tell a missing host from a missing macro.
    el.textContent = macroPlaceholder(taggedMacro, "no-host");
    el.setAttribute("data-testid", "macro-tagged-placeholder");
    return el;
  },
  htmlRender: () => html``,
  slash: { labelKey: "palette.tagged", keywords: "tagged tag list pages dynamic タグ 一覧 動的", insert: ":::tagged\n\n:::", caret: 10 },
};
