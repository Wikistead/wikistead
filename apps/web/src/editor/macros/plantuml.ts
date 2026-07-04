import type { FenceMacro } from "./registry";
import { plantumlHtmlRender } from "@wikistead/macro-render"; // #85: export htmlRender is shared, single source

// ```plantuml — PlantUML is GPL and needs a JRE, so it is NEVER bundled (ADR-011/ADR-074). The
// DEFAULT render is DEGRADE-TO-SOURCE: the fence shows its source verbatim (a code block), always
// valid Markdown, no external dependency. Rendered output is produced ONLY when an operator
// configures an external render service (Kroki / a PlantUML server) via the gated + SSRF-guarded
// host seam (ADR-074 / ADR-071) — a separate sub-task. Source is the canonical form (Open formats).
export const plantumlMacro: FenceMacro = {
  kind: "fence",
  lang: "plantuml",
  foldable: false, // #210 / #174 / ADR-087: no meaningless collapse button on a rendered diagram (like mermaid)
  // No bundled renderer: until an external service is configured the block degrades to its source.
  exportFidelity: "degrade",
  summary: () => "PlantUML diagram",
  slash: { labelKey: "palette.plantuml", keywords: "diagram uml plantuml sequence class component", insert: "```plantuml\n\n```", caret: 12 },
  liveRender(body) {
    const el = document.createElement("div");
    el.className = "cm-lp-macro cm-lp-plantuml";
    el.setAttribute("data-testid", "macro-plantuml");
    const pre = document.createElement("pre");
    const code = document.createElement("code");
    code.textContent = body.trim(); // textContent (never innerHTML) — XSS-safe for user-authored text
    pre.appendChild(code);
    el.appendChild(pre);
    return el;
  },
  // Static export degrades to the source (an external-render-enabled viewer can process it later).
  htmlRender: plantumlHtmlRender,
};
