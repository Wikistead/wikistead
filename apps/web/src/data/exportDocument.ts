// #85 / ADR-194 (Option B): the browser writes the document it already drew.
//
// The export used to be a second renderer with a hand-written stylesheet, and it lost to the screen every
// time it was put beside it — not because the values drifted but because the two sides emit different HTML
// (not one shared selector). This builds the file out of the DOM the app has ALREADY rendered, wearing the
// app's own stylesheet, so "looks the same" stops being a thing to keep in sync.
//
// Two properties this module owns, both pinned:
//   1. It is INERT. No <script>, no event-handler attribute, no non-raster data: URL — the same shape the
//      server's sanitizer enforces for what it serves. The file goes to disk and gets opened later, often
//      by someone else, so it must not be able to do anything.
//   2. It carries no CHROME. Copy buttons, edit affordances, presence boxes and the rest are the app's
//      controls, not the document's content; a printed page with a "Copy" button on it is a bug.
//
// It does NOT change anything the server serves (public pages, SSR, guest surfaces stay server-rendered and
// server-sanitized — ADR-059 as amended by ADR-194).

// Elements that belong to the app rather than to the document. Matched as selectors against the CLONE, so
// the live surface is never touched.
const CHROME_SELECTORS = [
  "button",
  "[data-testid=callout-panel] > .cm-lp-callout-panel-icon ~ button",
  ".cm-lp-code-copy",
  ".cm-lp-macro-btnrow",
  ".cm-lp-macro-richui-raw",
  ".cm-macro-presence-box",
  ".cm-lp-todo-demote",
  "[contenteditable]",
  "[data-print-hide]",
];

// Attributes that could make the file act: every event handler, plus the ones that carry a URL we then
// re-check. Anything not on the allowed URL schemes is dropped rather than rewritten — a broken image in a
// downloaded file is a smaller problem than a live one.
const URL_ATTRS = ["href", "src", "xlink:href", "action", "formaction", "poster", "background"];
const ALLOWED_DATA_IMAGE = /^data:image\/(?:png|jpeg|gif|webp|svg\+xml)[;,]/i;

// #85 (user ruling 2026-07-28): a tab strip is a way of showing one thing at a time, and on paper there is
// no "at a time" — every panel but the active one is hidden by CSS, so the export silently lost the other
// tabs' content. That is a document losing text, not a document losing interactivity, and the ruling is
// explicit that all tab content must survive. Each panel becomes a titled section (the tab's own label,
// taken from its button before the buttons are stripped) and the strip itself goes.
function expandTabs(root: HTMLElement): void {
  for (const tabs of Array.from(root.querySelectorAll(".cm-lp-tabs"))) {
    const labels = Array.from(tabs.querySelectorAll(".cm-lp-tabbar .cm-lp-tab")).map((b) => (b.textContent || "").trim());
    const panels = Array.from(tabs.querySelectorAll(".cm-lp-tabpanels > .cm-lp-tabpanel")) as HTMLElement[];
    if (!panels.length) continue;
    const out = document.createElement("div");
    out.className = "cm-lp-tabs wks-export-tabs";
    panels.forEach((panel, i) => {
      const section = document.createElement("section");
      section.className = "cm-lp-tabpanel cm-lp-tabpanel-active"; // the class the app styles a shown panel with
      const label = labels[i];
      if (label) {
        const h = document.createElement("div");
        h.className = "cm-lp-tab-label";
        h.textContent = label; // text, never markup
        section.appendChild(h);
      }
      while (panel.firstChild) section.appendChild(panel.firstChild);
      out.appendChild(section);
    });
    tabs.replaceWith(out);
  }
}

// #85 (user ruling): a `:::details` keeps its disclosure LOOK in the file — <details>/<summary> are
// standard elements, so nothing has to be invented — but it travels OPEN. Closed, the body is in the file
// and invisible, which is the same way the tabs lost text: on paper there is no clicking it open.
function openDisclosures(root: HTMLElement): void {
  for (const d of Array.from(root.querySelectorAll("details"))) (d as HTMLDetailsElement).open = true;
}

function stripChrome(root: HTMLElement): void {
  for (const sel of CHROME_SELECTORS) {
    for (const el of Array.from(root.querySelectorAll(sel))) el.remove();
  }
}

function makeInert(root: HTMLElement): void {
  for (const el of Array.from(root.querySelectorAll("script, iframe, object, embed, form"))) el.remove();
  for (const el of Array.from(root.querySelectorAll("*"))) {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      // every on* handler, and javascript:/vbscript: in any URL-bearing attribute
      if (name.startsWith("on")) { el.removeAttribute(attr.name); continue }
      if (URL_ATTRS.includes(name)) {
        const v = (attr.value || "").trim();
        if (/^(javascript|vbscript|data):/i.test(v) && !ALLOWED_DATA_IMAGE.test(v)) el.removeAttribute(attr.name);
      }
    }
  }
}

// The app's own CSS, read back out of the live document. Same-origin sheets expose their rules; a sheet we
// cannot read (a cross-origin one — the app ships none today) is skipped rather than guessed at. Reading it
// from the document instead of re-declaring it is the entire point: there is one stylesheet, and this is it.
export function collectAppCss(doc: Document = document): string {
  const parts: string[] = [];
  for (const sheet of Array.from(doc.styleSheets)) {
    let rules: CSSRuleList | null = null;
    try { rules = (sheet as CSSStyleSheet).cssRules } catch { rules = null } // cross-origin → unreadable
    if (!rules) continue;
    for (const rule of Array.from(rules)) parts.push(rule.cssText);
  }
  return parts.join("\n");
}

export interface ExportDocumentInput {
  readonly title: string;
  readonly body: HTMLElement; // the rendered read surface (already drawn — diagrams included)
  readonly css?: string; // defaults to the live document's stylesheets
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Build the standalone document. Pure with respect to the page: it clones before it edits, so the surface
// the user is looking at is untouched.
export function buildExportDocument(input: ExportDocumentInput): string {
  const clone = input.body.cloneNode(true) as HTMLElement;
  expandTabs(clone); // before the chrome goes: the labels live on the tab BUTTONS
  openDisclosures(clone);
  stripChrome(clone);
  makeInert(clone);
  const css = input.css ?? collectAppCss();
  const t = escapeHtml(input.title || "Untitled");
  // The wrapper carries `wks-prose` and the light theme: the file is made to be shared and printed, and a
  // reader's OS theme deciding its colours is what the #85 review rejected.
  return `<!doctype html>
<html lang="en" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${t}</title>
<style>${css}</style>
<style>
:root{color-scheme:light}
body{margin:0;background:var(--bg,#fff);color:var(--fg,#1f2328)}
.wks-export-doc{max-width:46rem;margin:2rem auto;padding:0 1rem}
@page{margin:14mm}
@media print{.wks-export-doc{max-width:none;margin:0}}
</style>
</head>
<body>
<main class="wks-export-doc wks-prose">
<h1 class="wks-export-title">${t}</h1>
${clone.innerHTML}
</main>
</body>
</html>
`;
}
