import { asMacroSource, type FenceMacro } from "./registry";
import { macroPlaceholder, showPlaceholder } from "./placeholder"; // #600: one template for every "cannot show it" state
import { diagramVerdict } from "../live-preview/decorations";
import { plantumlHtmlRender } from "@wikistead/macro-render"; // #85: export htmlRender is shared, single source
import { mountSourceEditor } from "./source-editor"; // #243 / ADR-111 C3: CM6 mini-editor source pane

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
    // #600: an empty fence used to render an empty <pre> — an invisible block with nothing to read.
    if (!body.trim()) {
      el.classList.add("cm-lp-macro-empty");
      showPlaceholder(el, plantumlMacro, "empty-edit");
      return el;
    }
    const pre = document.createElement("pre");
    const code = document.createElement("code");
    code.textContent = body.trim(); // textContent (never innerHTML) — XSS-safe for user-authored text
    pre.appendChild(code);
    el.appendChild(pre);
    return el;
  },
  // #174 / ADR-087 addendum (comment 716): plantuml gets the single edit button → an inline editUI. In
  // WYSIWYG the raw source is hidden and Ctrl+Enter is the vim×Live path, so a non-vim user otherwise has
  // NO way to edit a plantuml block — the edit button closes that gap (the reviewer's ask: an edit
  // button even for macros with no WYSIWYG editing means). No bundled renderer, so the panel is a
  // source textarea + a degraded
  // code preview (the same degrade-to-source shape liveRender shows); it upgrades for free once an
  // external render service is wired (ADR-074). Host-API is { theme } + save only (ADR-024); save lands
  // on `change` (blur), NOT per keystroke — a per-keystroke Y.Text write re-mounts the widget mid-typing.
  editUI: {
    present: "inline",
    mount(container, source, ctx, save, editEnv) {
      const wrap = document.createElement("div");
      wrap.className = "cm-lp-plantuml-edit";
      // #243 / ADR-111 C3 (slice 1): CM6 mini-editor source pane (see source-editor.ts); commit on blur only.
      const src = document.createElement("div");
      src.className = "cm-lp-plantuml-edit-src";
      const preview = document.createElement("div");
      preview.className = "cm-lp-plantuml cm-lp-plantuml-edit-preview";
      preview.setAttribute("data-testid", "plantuml-edit-preview");
      const showSource = (code: string) => {
        const pre = document.createElement("pre");
        const el = document.createElement("code");
        el.textContent = code.trim(); // textContent (never innerHTML) — XSS-safe for user text
        pre.appendChild(el);
        preview.replaceChildren(pre);
      };
      // #525: when the host lends a renderer (an operator has configured the external service), the preview
      // shows the DIAGRAM — the read surface already did, so an open editUI showing source was the odd one
      // out. The macro still never fetches (ADR-024): it hands its source to the host seam and gets bytes.
      // `seq` makes it latest-wins so a slow render for an older keystroke can't overwrite a newer preview,
      // and each object URL is revoked when replaced so a long editing session doesn't leak blobs. No
      // renderer (or a null result = unconfigured / failed / non-viewer) → the degrade-to-source preview.
      let seq = 0;
      let objectUrl: string | null = null;
      const dropUrl = () => { if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; } };
      const renderPreview = (code: string) => {
        const host = editEnv?.renderDiagram;
        if (!host) { showSource(code); return; }
        const mine = ++seq;
        void host(asMacroSource(code)).then((res) => {
          if (mine !== seq) return; // superseded by a newer keystroke
          // #525mermaid parity — an INVALID diagram says so (the author is mid-edit and can fix
          // it), an outage says so separately, and an unconfigured endpoint just shows the source.
          const v = diagramVerdict(res);
          if (!("blob" in v)) {
            showSource(code); // the source is always kept — never a broken embed
            if (v.reason !== "degrade") {
              const msg = document.createElement("div");
              msg.className = "cm-lp-macro-error-msg";
              msg.setAttribute("data-testid", "plantuml-edit-error");
              // #600: both sentences now name the macro and share the shape every other placeholder has.
              showPlaceholder(msg, plantumlMacro, v.reason === "invalid" ? "invalid" : "unreachable");
              preview.prepend(msg);
            }
            return;
          }
          dropUrl();
          objectUrl = URL.createObjectURL(v.blob);
          const img = document.createElement("img");
          img.className = "cm-lp-macro-rendered";
          img.alt = "plantuml diagram";
          img.setAttribute("data-testid", "plantuml-edit-rendered");
          img.src = objectUrl;
          preview.replaceChildren(img);
        }).catch(() => { if (mine === seq) showSource(code); });
      };
      // Typing calls this per keystroke; a render is a network round-trip, so coalesce to the pause in
      // typing (the read surface renders once per widget). The initial preview is immediate.
      let idle: ReturnType<typeof setTimeout> | undefined;
      const schedulePreview = (code: string) => {
        if (idle) clearTimeout(idle);
        idle = setTimeout(() => renderPreview(code), 500);
      };
      renderPreview(source);
      wrap.append(src, preview);
      container.appendChild(wrap);
      // #456 S5: the source pane comes from the HOST now (kind "code" — this source IS code, so it
      // keeps the code face and skips the markdown decoration layer). The macro asks for a surface and
      // gets a handle; it never builds one, so vim and the rest stay configured in exactly one place.
      // Falls back to the macro-side helper when no host lends a surface (unit tests, older callers).
      const editor = editEnv?.mountSurface?.({
        parent: src,
        doc: asMacroSource(source),
        kind: "code",
        testid: "plantuml-edit-src",
        onInput: (v) => schedulePreview(v), // local live preview, no doc write (coalesced — #525)
        onCommit: (v) => save(v), // one offset-invariant Y.Text edit, on blur
      }) ?? mountSourceEditor({
        parent: src,
        doc: source,
        dark: ctx.theme === "dark",
        vim: editEnv?.vim,
        testid: "plantuml-edit-src",
        onInput: (v) => schedulePreview(v),
        onCommit: (v) => save(asMacroSource(v)),
      });
      const focus = setTimeout(() => editor.focus(), 0);
      return {
        handlesEscape: () => editor.inVimInsert(), // #243 C3 slice 2b: first Escape = vim insert→normal, not exit
        destroy() {
          clearTimeout(focus);
          if (idle) clearTimeout(idle); // #525: no render fires after the panel is gone
          seq++; // invalidate an in-flight render so its .then() can't touch the detached DOM
          dropUrl();
          editor.destroy();
          wrap.remove();
        },
      };
    },
  },
  // Static export degrades to the source (an external-render-enabled viewer can process it later).
  htmlRender: plantumlHtmlRender,
};
