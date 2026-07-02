import type { FenceMacro, MacroContext } from "./registry";
import { html } from "./safe-html";

// The first macro: ```mermaid renders a diagram. It proves the registry pipeline
// (register -> liveRender -> fold -> Markdown round-trip) on the code-fence path,
// which needs NO parser. mermaid is MIT (license:check gate cleared).

let seq = 0;
const nextId = () => `wks-mermaid-${seq++}`;

// Lazy-loaded so mermaid (large) stays out of the main bundle — imported on first
// render of a ```mermaid block. `securityLevel: "strict"` makes mermaid sanitize the
// SVG it produces (it bundles DOMPurify), so user-authored diagram text cannot inject
// script even though we assign the result via innerHTML below. Theme is bound at first
// load (a mid-session theme switch re-rendering existing diagrams is M2 polish).
let mermaidP: Promise<typeof import("mermaid")["default"]> | null = null;
function loadMermaid(theme: MacroContext["theme"]) {
  if (!mermaidP) {
    mermaidP = import("mermaid").then(({ default: mermaid }) => {
      // suppressErrorRendering (#191): on a syntax error mermaid otherwise injects a "bomb" error
      // diagram into the DOM (body), which accumulates on every re-render/keystroke. Suppress it —
      // we render our own in-macro error message in the catch below.
      mermaid.initialize({ startOnLoad: false, securityLevel: "strict", suppressErrorRendering: true, theme: theme === "dark" ? "dark" : "default" });
      return mermaid;
    });
  }
  return mermaidP;
}

export const mermaidMacro: FenceMacro = {
  kind: "fence",
  lang: "mermaid",
  exportFidelity: "preserve", // declarative text body → round-trips verbatim
  summary: () => "Mermaid diagram",
  slash: { labelKey: "palette.mermaid", keywords: "diagram flowchart graph chart mermaid", insert: "```mermaid\n\n```", caret: 11 },
  liveRender(body, ctx) {
    const el = document.createElement("div");
    el.className = "cm-lp-macro cm-lp-mermaid";
    el.setAttribute("data-testid", "macro-mermaid");
    const code = body.trim();
    if (!code) return el;
    const id = nextId();
    void loadMermaid(ctx.theme).then(async (mermaid) => {
      try {
        const { svg } = await mermaid.render(id, code);
        el.innerHTML = svg; // sanitized by mermaid (securityLevel: strict)
      } catch {
        el.classList.add("cm-lp-macro-error");
        el.textContent = "Invalid mermaid diagram"; // in-macro only (suppressErrorRendering stops the body bomb)
      } finally {
        // Belt-and-suspenders (#191): mermaid.render appends a temp element PREFIXED with 'd' (d<id>)
        // to the DOM for measurement; on an error path it can linger. Remove only THAT — never #<id>,
        // which is the id of the RENDERED <svg> we assigned into `el` above (removing it deleted valid
        // diagrams — #191 review regression: mermaid names the output svg `${id}`, so
        // getElementById(id) found the real figure inside `el`, not a stray temp).
        document.getElementById("d" + id)?.remove(); // mermaid prefixes the temp/error container with 'd'
      }
    });
    return el;
  },
  // M3 wires HTML export server-side. mermaid renders in the browser, so the static
  // form is the source in a <pre class="mermaid"> (a mermaid-enabled HTML viewer
  // renders it; any other shows the code). XSS-safe: the body is escaped.
  htmlRender: (body) => html`<pre class="mermaid">${body}</pre>`,
};
