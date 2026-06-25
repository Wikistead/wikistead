import type { DirectiveMacro } from "./registry";

// The first directive macro: :::callout … ::: renders as a styled box whose content
// stays Markdown (parsed nested, decorated by the existing renderers; the ::: fence
// lines are hidden, reveal-on-cursor). Proves the directive pipeline (in-house lezer
// parser → registry → live render → round-trip) on the Markdown-container path.

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export const calloutMacro: DirectiveMacro = {
  kind: "directive",
  name: "callout",
  containerClass: "cm-lp-callout",
  exportFidelity: "preserve", // ::: stays plain text → lossless round-trip
  slash: { labelKey: "palette.callout", keywords: "callout note info aside admonition tip warning", insert: ":::callout\n\n:::", caret: 11 },
  // M3 wires HTML export server-side, where the inner Markdown is rendered and wrapped
  // by this. For now it supplies the wrapper; escaping keeps it XSS-safe as a fallback.
  htmlRender: (body) => `<div class="callout">\n\n${escapeHtml(body)}\n\n</div>`,
};
