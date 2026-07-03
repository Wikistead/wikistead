import DOMPurify from "isomorphic-dompurify";

// #85 / ADR-059: the server-side HTML sanitizer — the SINGLE trust boundary for exported / published
// / SSR HTML. Every macro→HTML string (including `:::table` raw HTML that already passed the
// table-model allowlist) is re-sanitized here, so raw passthrough is ZERO. The sanitizer is OSS
// (isomorphic-dompurify + jsdom — never hand-rolled: mXSS / namespace confusion are unavoidable by
// hand) and namespace-aware (MathML for KaTeX `output:"mathml"`). htmlRender purity upstream is
// "correctness", NOT trust — this pass is the only thing standing between rendered output and the
// browser.
//
// Confirmed policy (ADR-059 "Security decisions"):
//   - No inline SVG. mermaid/excalidraw degrade to a static image/placeholder before render; a stray
//     <svg>/<foreignObject> is stripped here as defence-in-depth (the MathML namespace stays).
//   - `<script>` / event handlers (on*) / `javascript:` URLs removed (DOMPurify defaults).
//   - inline `style` stripped entirely — class-only.
//   - `data:` URLs limited to raster images (png/jpeg/gif/webp); data:image/svg+xml, data:text/html
//     and data:application/* are rejected.

// Bump on ANY policy change below. The export cache key carries this version so HTML rendered by an
// older (possibly bypassable) policy is never served after a patch — a cache-bust on policy change.
export const SANITIZER_POLICY_VERSION = 1;

// A `data:` URL is permitted ONLY when it is one of these raster image types. Everything else
// (svg+xml, text/html, application/*) is dropped. The trailing `[;,]` guards against a bare prefix
// match (`data:image/pngX...`).
const ALLOWED_DATA_IMAGE = /^data:image\/(?:png|jpeg|gif|webp)[;,]/i;

// Every attribute that can carry a URL. DOMPurify's scheme allowlist already rejects javascript:/
// vbscript: on these; our hook adds the finer `data:`-scheme granularity the ADR requires.
const URI_ATTRS = ["href", "src", "xlink:href", "action", "formaction", "poster", "background"];

let hooksInstalled = false;
function installHooks(): void {
  if (hooksInstalled) return;
  hooksInstalled = true;
  // DOMPurify keeps `data:` URLs on image-bearing tags (img/source/...) by default and can't express
  // "raster only" declaratively — so we re-check every URL attribute after sanitisation and drop any
  // `data:` URL that isn't an allowed raster image. Non-data URLs already passed DOMPurify's scheme
  // allowlist, so they're left alone here.
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    const el = node as unknown as Element;
    if (typeof el.getAttribute !== "function") return;
    for (const attr of URI_ATTRS) {
      const v = el.getAttribute(attr);
      if (v == null) continue;
      const val = v.trim();
      if (/^data:/i.test(val) && !ALLOWED_DATA_IMAGE.test(val)) el.removeAttribute(attr);
    }
  });
}

// Sanitize rendered HTML for export/publish. Returns a safe HTML string (never executes script,
// never carries inline style, never an inline SVG or a non-raster data: URL). Idempotent and pure.
export function sanitizeExportHtml(dirty: string): string {
  installHooks();
  return DOMPurify.sanitize(dirty, {
    // HTML + MathML only. NO svg profile: we never emit inline SVG (excalidraw/mermaid degrade to a
    // static image), so <svg>/<foreignObject> have no legitimate use and are an XSS surface.
    USE_PROFILES: { html: true, mathMl: true },
    // inline style is stripped — class-only (ADR-059 decision-4; KaTeX mathml output needs no style).
    FORBID_ATTR: ["style"],
    // Defence-in-depth belt-and-braces: these are already excluded by the profiles, but naming them
    // makes the intent explicit and survives a profile change.
    FORBID_TAGS: ["script", "style", "svg", "foreignobject", "iframe", "object", "embed", "form"],
    ALLOW_DATA_ATTR: false,
  });
}
