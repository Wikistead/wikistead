import type { FenceMacro, MacroContext } from "./registry";

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
      mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: theme === "dark" ? "dark" : "default" });
      return mermaid;
    });
  }
  return mermaidP;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export const mermaidMacro: FenceMacro = {
  kind: "fence",
  lang: "mermaid",
  exportFidelity: "preserve", // declarative text body → round-trips verbatim
  summary: () => "Mermaid diagram",
  liveRender(body, ctx) {
    const el = document.createElement("div");
    el.className = "cm-lp-macro cm-lp-mermaid";
    el.setAttribute("data-testid", "macro-mermaid");
    const code = body.trim();
    if (!code) return el;
    void loadMermaid(ctx.theme).then(async (mermaid) => {
      try {
        const { svg } = await mermaid.render(nextId(), code);
        el.innerHTML = svg; // sanitized by mermaid (securityLevel: strict)
      } catch {
        el.classList.add("cm-lp-macro-error");
        el.textContent = "Invalid mermaid diagram";
      }
    });
    return el;
  },
  // M3 wires HTML export server-side. mermaid renders in the browser, so the static
  // form is the source in a <pre class="mermaid"> (a mermaid-enabled HTML viewer
  // renders it; any other shows the code). XSS-safe: the body is escaped.
  htmlRender: (body) => `<pre class="mermaid">${escapeHtml(body)}</pre>`,
};
