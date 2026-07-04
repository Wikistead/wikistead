import { asMacroSource, type FenceMacro } from "./registry";
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
  // #174 / ADR-087 addendum (comment 716): plantuml gets the single edit button → an inline editUI. In
  // WYSIWYG the raw source is hidden and Ctrl+Enter is the vim×Live path, so a non-vim user otherwise has
  // NO way to edit a plantuml block — the edit button closes that gap (the reviewer's "WYSIWYG
  // "). No bundled renderer, so the panel is a source textarea + a degraded
  // code preview (the same degrade-to-source shape liveRender shows); it upgrades for free once an
  // external render service is wired (ADR-074). Host-API is { theme } + save only (ADR-024); save lands
  // on `change` (blur), NOT per keystroke — a per-keystroke Y.Text write re-mounts the widget mid-typing.
  editUI: {
    present: "inline",
    mount(container, source, _ctx, save) {
      const wrap = document.createElement("div");
      wrap.className = "cm-lp-plantuml-edit";
      const ta = document.createElement("textarea");
      ta.className = "cm-lp-plantuml-edit-src";
      ta.value = source;
      ta.spellcheck = false;
      ta.setAttribute("data-testid", "plantuml-edit-src");
      const preview = document.createElement("div");
      preview.className = "cm-lp-plantuml cm-lp-plantuml-edit-preview";
      preview.setAttribute("data-testid", "plantuml-edit-preview");
      const renderPreview = (code: string) => {
        const pre = document.createElement("pre");
        const el = document.createElement("code");
        el.textContent = code.trim(); // textContent (never innerHTML) — XSS-safe for user text
        pre.appendChild(el);
        preview.replaceChildren(pre);
      };
      ta.addEventListener("input", () => renderPreview(ta.value)); // local preview only, no doc write
      ta.addEventListener("change", () => save(asMacroSource(ta.value))); // commit to Y.Text on blur
      renderPreview(source);
      wrap.append(ta, preview);
      container.appendChild(wrap);
      const focus = setTimeout(() => ta.focus(), 0);
      return { destroy() { clearTimeout(focus); wrap.remove(); } };
    },
  },
  // Static export degrades to the source (an external-render-enabled viewer can process it later).
  htmlRender: plantumlHtmlRender,
};
