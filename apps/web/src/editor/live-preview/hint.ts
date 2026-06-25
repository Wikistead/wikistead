import type { Tooltip } from "@codemirror/view";

// A small, unobtrusive caret-context hint shown in the CodeMirror TOOLTIP layer — never
// a node in view.dom, so document offsets / presence are untouched (#8). Shared by the
// vim-`\` decorate hint (ADR-017 M0-3) and the macro reveal↔render hint (ADR-022 Part
// 11) so their position and style stay identical. Styled by `.cm-tooltip.lp-context-hint`.
export function contextHintTooltip(pos: number, text: string, testid: string): Tooltip {
  return {
    pos,
    above: true,
    strictSide: false,
    arrow: false,
    create: () => {
      const dom = document.createElement("div");
      dom.className = "lp-context-hint";
      dom.setAttribute("data-testid", testid);
      dom.textContent = text;
      return { dom };
    },
  };
}
