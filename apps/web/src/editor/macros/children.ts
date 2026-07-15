import type { DirectiveMacro } from "./registry";
import { html } from "@wikistead/macro-render";

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
  liveRender: () => {
    const el = document.createElement("div");
    el.className = "cm-lp-macro cm-lp-query-placeholder";
    el.setAttribute("data-testid", "macro-children-placeholder");
    return el;
  },
  htmlRender: () => html``,
  slash: { labelKey: "palette.children", keywords: "children child pages tree list dynamic 子ページ 一覧 動的", insert: ":::children\n:::\n", caret: 16 },
};
