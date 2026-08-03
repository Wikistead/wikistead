import type { DirectiveMacro } from "./registry";
import { html } from "@wikistead/macro-render";
import { macroPlaceholder } from "./placeholder"; // #600: one template for every "cannot show it" state

// :::children — an in-body, read-only DYNAMIC LIST of THIS page's direct child pages (#370 / ADR-145;
// kept tag-independent from ADR-134's `:::query children` by user ruling). Empty body. Same host-mediated
// contract as :::tagged: the macro never fetches; the host resolves via the member-only, view-filtered
// `GET /pages/:id/list?name=children`; the public/guest surface renders the baked anonymous snapshot.
export const childrenMacro: DirectiveMacro = {
  kind: "directive",
  name: "children",
  exportFidelity: "degrade",
  revealOnCursor: true,
  // #395 / ADR-156: a zero-argument dynamic block — nothing to type, nothing to pick — is an ATOM
  // an empty caret SELECTS it (ring), raw shows only via explicit entry (Ctrl+Enter) or Source.
  // It carried revealOnCursor without atomSelectable (the ADR-156 "straggler"), stranding a caret
  // on a body with nothing to edit.
  atomSelectable: true,
  capabilities: ["host-list"], // #450 slice 5c: the host resolves the list; the macro only asks for the slot
  liveRender: (body, ctx) => {
    // #450 slice 5c: ONE resolution path. The host used to spot this macro BY NAME at two different
    // sinks (the CM widget and the nested renderer) and fill it in — two lifecycles for one question,
    // which is how the nested copy came to sit at its placeholder forever. Now the macro asks and the
    // host answers; there is nothing left to keep in step.
    const slot = ctx?.hostSlot?.({ kind: "list", source: "children", query: body });
    if (slot) return slot;
    // No host slot on this surface (export, hover card, anonymous): the placeholder, exactly as before.
    const el = document.createElement("div");
    el.className = "cm-lp-macro cm-lp-query-placeholder";
    // #600: this branch rendered an EMPTY div, so a surface with no list host showed a block of zero
    // height. Nothing to click, nothing to read, no way to tell a missing host from a missing macro.
    el.textContent = macroPlaceholder(childrenMacro, "no-host");
    el.setAttribute("data-testid", "macro-children-placeholder");
    return el;
  },
  htmlRender: () => html``,
  slash: { labelKey: "palette.children", keywords: "children child pages tree list dynamic 子ページ 一覧 動的", insert: ":::children\n:::\n", caret: 16 },
};
