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
// The root must NOT carry `data-print-root` (#85, measured twice): that attribute belongs to the
// app's print PORTAL, and the app stylesheet — which travels with this file — attaches a contract to it
// in BOTH media: hidden on screen (`[data-print-root] { display: none }`), shown in print. Wearing it
// made printing work and OPENING the file blank (root 0×0, display none); not wearing anything made
// opening work and PRINTING blank. The way out is the export's own marker: the root is identified by
// `.wks-export-doc`, and print.css names that class beside the portal attribute in its print rules, so
// the saved file is visible on screen AND survives print without borrowing the portal's semantics.
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
  // `[contenteditable=true]` only. Matching the bare attribute took the fence HEADER with it — the file-name
  // tab and language chip are marked contenteditable="false" so CodeMirror leaves them alone, and stripping
  // them dropped the fence's whole chrome from the export (measured: the card arrived with no header at all).
  "[contenteditable=true]",
  "[data-print-hide]",
];

// Attributes that could make the file act: every event handler, plus the ones that carry a URL we then
// re-check. Anything not on the allowed URL schemes is dropped rather than rewritten — a broken image in a
// downloaded file is a smaller problem than a live one.
const URL_ATTRS = ["href", "src", "xlink:href", "action", "formaction", "poster", "background"];
// Raster only — the same line ADR-194 pins for the file and ADR-059 pins for the server sink. A drawn SVG
// travels as an ELEMENT (mermaid/excalidraw render inline), never as a data: URL, so the scheme allowance
// has no raster-less customer.
const ALLOWED_DATA_IMAGE = /^data:image\/(?:png|jpeg|gif|webp)[;,]/i;
const RASTER_BLOB_TYPE = /^image\/(?:png|jpeg|gif|webp)$/i;

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
    // #598: carry the element's NAME across the rebuild. The parity gate asks each surface for its
    // elements by name, and this transform replaced the tab strip with a fresh div — so the saved file
    // held the tabs' content under no name at all, and the gate could see the text but not the element.
    // Anything that rebuilds a macro's element on the way out has to bring its identity with it.
    const name = tabs.getAttribute("data-wks-el");
    if (name) out.setAttribute("data-wks-el", name);
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
  // The attribute itself has no business in a document nobody can edit; the elements wearing it stay.
  for (const el of Array.from(root.querySelectorAll("[contenteditable]"))) el.removeAttribute("contenteditable");
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
        // blob: is dropped because it CANNOT work here: it is a handle into the session that minted it,
        // dead the moment this file is opened on its own. Anything worth keeping was already baked into a
        // data: URL by inlineTransientImages; what remains would only ever render as a broken reference.
        if (/^(javascript|vbscript|data|blob):/i.test(v) && !ALLOWED_DATA_IMAGE.test(v)) el.removeAttribute(attr.name);
      }
    }
  }
}

// #85 review reject: a host-rendered diagram (plantuml) reaches the surface as
// `<img src="blob:…">`, and a blob: URL does not survive the document that created it — the print frame
// still resolved it, so every print path passed while the DOWNLOADED file opened to a broken image. Before
// the surface is serialized, each blob image is read back and baked in as a raster data: URL; one that
// cannot be read (or is not a raster) keeps its src and makeInert drops it, because shipping a reference
// that is known-dead is worse than shipping nothing.
async function loadBlobAsDataUrl(src: string): Promise<string | null> {
  const blob = await (await fetch(src)).blob();
  if (!RASTER_BLOB_TYPE.test(blob.type)) return null;
  return await new Promise<string | null>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(typeof r.result === "string" ? r.result : null);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

export async function inlineTransientImages(
  root: HTMLElement,
  load: (src: string) => Promise<string | null> = loadBlobAsDataUrl,
): Promise<void> {
  const imgs = Array.from(root.querySelectorAll('img[src^="blob:"]'));
  await Promise.all(imgs.map(async (img) => {
    const data = await load(img.getAttribute("src")!).catch(() => null);
    if (data && ALLOWED_DATA_IMAGE.test(data)) img.setAttribute("src", data);
  }));
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

// #85 / ADR-194 addendum A, ruling A2 (2026-08-05): embed the CODE face and nothing else.
//
// The collected stylesheet carries @font-face rules whose url() is root-absolute (`/assets/…woff2`), so a
// file opened from disk asks the FILESYSTEM ROOT for them and every one 404s — measured by the parity gate,
// which listed those requests as known-red. A1 (embed everything) was rejected: 3.2MB of HTML is its own
// kind of broken. A2 keeps code blocks looking like the screen (~40KB) and lets prose fall to a generic.
//
// The set is DERIVED, not listed. The body face is a user choice (FontProvider / ADR-090), so a hard-coded
// "Wikistead Mono" would embed the wrong file for anyone who changed their setting — the rule is "whatever
// --font-code actually resolves to in this document". Everything not embedded has its @font-face REMOVED in
// the same pass: leaving a rule whose url cannot resolve is the 404 this fixes, and the token stacks all end
// in a generic (ui-monospace / system-ui), so dropping the rule lands on that generic rather than nowhere.
const FONT_FACE_BLOCK = /@font-face\s*\{[^}]*\}/gi
const FAMILY_IN_BLOCK = /font-family\s*:\s*([^;}]+)/i
const URL_IN_BLOCK = /url\(\s*(['"]?)([^)'"]+)\1\s*\)/i

/** The family names in a CSS font stack, unquoted and lowercased; generics included (harmless — no
 *  @font-face declares one). */
export function familiesInStack(stack: string): string[] {
  return stack.split(",").map((s) => s.trim().replace(/^['"]|['"]$/g, "").toLowerCase()).filter(Boolean)
}

async function fetchAsDataUrl(url: string): Promise<string | null> {
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    const buf = new Uint8Array(await res.arrayBuffer())
    let bin = ""
    for (const b of buf) bin += String.fromCharCode(b)
    return `data:font/woff2;base64,${btoa(bin)}`
  } catch { return null }
}

/**
 * Rewrite the collected CSS so the code face travels inside the file and no other @font-face survives.
 * Pure with respect to the document; the two seams are injectable so this is measurable without a network.
 */
export async function inlineCodeFontFaces(
  css: string,
  opts: {
    codeStack?: string
    fetchFont?: (url: string) => Promise<string | null>
  } = {},
): Promise<string> {
  const stack = opts.codeStack
    ?? (typeof getComputedStyle === "function"
      ? getComputedStyle(document.documentElement).getPropertyValue("--font-code")
      : "")
  const wanted = new Set(familiesInStack(stack))
  const fetchFont = opts.fetchFont ?? fetchAsDataUrl
  const blocks = css.match(FONT_FACE_BLOCK) ?? []
  const replacements = new Map<string, string>()
  for (const block of blocks) {
    const family = FAMILY_IN_BLOCK.exec(block)?.[1]?.trim().replace(/^['"]|['"]$/g, "").toLowerCase()
    const url = URL_IN_BLOCK.exec(block)?.[2]
    // not the code face, or nothing to fetch → the rule goes. A dropped rule falls to the stack's generic;
    // a kept-but-unresolvable rule is the 404.
    if (!family || !url || !wanted.has(family) || /^data:/i.test(url)) {
      replacements.set(block, /^data:/i.test(url ?? "") && family && wanted.has(family) ? block : "")
      continue
    }
    const data = await fetchFont(url)
    replacements.set(block, data ? block.replace(URL_IN_BLOCK, `url(${data})`) : "")
  }
  let out = css
  for (const [from, to] of replacements) out = out.split(from).join(to)
  return out
}

export interface ExportDocumentInput {
  readonly title: string;
  readonly body: HTMLElement; // the rendered read surface (already drawn — diagrams included)
  readonly css?: string; // defaults to the live document's stylesheets
  /**
   * The language the page is written in. Defaults to the live document's, which is the point: this used to
   * be the literal `en`, and `:root:lang(en)` (#190 / ADR-090 — an English body is monospaced so vim's
   * columns hold) then switched the BODY of a Japanese page to the code face. Measured: the same string
   * drew 152px on screen and 170px in the saved file. Embedding the code face (A2) is what made that
   * visible — before it, the mismatch fell back to `ui-monospace` and hid.
   *
   * A Japanese document announcing `lang="en"` is also simply wrong for assistive technology and line
   * breaking, so this is not only a typography fix.
   */
  readonly lang?: string;
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// #85 / ADR-194 addendum A: the stylesheet is interpolated into a <style> block, and until this ruling it
// went in unexamined — so "the file is inert" was a claim about ELEMENTS while a whole second language rode
// along beside them. The element rules and the CSS rules are the same rules now:
//   - a data: URL may be a raster image or a font, and nothing else (an svg data: URL is a document with a
//     script surface; a woff2 is not);
//   - no `@import`, which is a fetch the reader did not ask for and a channel out of the file;
//   - no `</style` sequence, which ends the block early and hands the rest of the sheet to the HTML parser.
// Values are dropped rather than rewritten, for the same reason makeInert drops attributes.
const CSS_SAFE_DATA_URL = /^data:(?:image\/(?:png|jpeg|gif|webp)|font\/[\w.+-]+|application\/font-woff2?)[;,]/i;
export function sanitizeCss(css: string): string {
  return css
    .replace(/@import[^;]*;?/gi, "")
    // Quoted first, and the quoted forms may CONTAIN `)` — `url("data:image/svg+xml,<svg onload=steal()>")`
    // is the case that slipped through a `[^)]*` body (measured: the smuggled svg survived).
    .replace(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi, (whole, dq?: string, sq?: string, bare?: string) => {
      const url = (dq ?? sq ?? bare ?? "").trim()
      return /^data:/i.test(url) && !CSS_SAFE_DATA_URL.test(url) ? "url()" : whole
    })
    // case-insensitive, and any whitespace the parser would tolerate between the name and `>`
    .replace(/<\s*\/\s*style/gi, "<\\/style");
}

// Build the standalone document. Pure with respect to the page: it clones before it edits, so the surface
// the user is looking at is untouched.
export function buildExportDocument(input: ExportDocumentInput): string {
  const clone = input.body.cloneNode(true) as HTMLElement;
  expandTabs(clone); // before the chrome goes: the labels live on the tab BUTTONS
  openDisclosures(clone);
  stripChrome(clone);
  makeInert(clone);
  const css = sanitizeCss(input.css ?? collectAppCss());
  const t = escapeHtml(input.title || "Untitled");
  // The document's OWN language, not a literal (see ExportDocumentInput.lang). Escaped like any other
  // attribute: it comes from the page, and the page is not the author of this file's markup.
  const lang = escapeHtml((input.lang ?? document.documentElement.lang ?? "").trim() || "en");
  // The wrapper carries `wks-prose` and the light theme: the file is made to be shared and printed, and a
  // reader's OS theme deciding its colours is what the #85 review rejected. The THEME stays pinned
  // (#207paper is light whatever the screen is); only the language travels.
  return `<!doctype html>
<html lang="${lang}" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${t}</title>
<style>${css}</style>
<style>
:root{color-scheme:light}
body{margin:0;background:var(--bg,#fff);color:var(--fg,#1f2328)}
.wks-export-doc{max-width:46rem;margin:2rem auto;padding:0 1rem}
/* #207: expandTabs() replaces the strip with titled sections, and .cm-lp-tab-label is a class this module
   INVENTS — the app stylesheet has no rule for it, so every tab title printed as bare body text and the tabs
   arrived with no frame or separation at all (measured in the real print document: the label was
   indistinguishable from a paragraph). The look is borrowed from the on-screen active tab
   (.cm-lp-tabs .cm-lp-tab-active: accent underline, full-strength text) and uses the same tokens, so paper
   and screen stay one palette. Note this block is inside a template literal: no backticks below. */
.wks-export-tabs>.cm-lp-tabpanel+.cm-lp-tabpanel{margin-top:1.2em}
.wks-export-tabs>.cm-lp-tabpanel{border-top:1px solid var(--border,#888);padding-top:0.5em}
.wks-export-tabs>.cm-lp-tabpanel:first-child{border-top:none;padding-top:0}
.cm-lp-tab-label{display:inline-block;font:inherit;font-weight:600;color:var(--fg);
  padding:0.2em 0.6em 0.2em 0;border-bottom:2px solid var(--accent);margin-bottom:0.6em}
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
