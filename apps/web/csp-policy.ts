// #990 / ADR-277: the app shell's Content-Security-Policy, burned into the BUILT `index.html` as a
// `<meta http-equiv>` tag so it travels with the file — the static web container, `public-shell.ts`'s
// direct disk read (ADR-154) and any future ingress all serve the same bytes, and there is no single
// proxy layer every topology shares that could add a header instead.
//
// Two things this file is deliberately strict about, because each was measured to matter (ADR-277
// §Decision, two review rounds against the real build output):
//   - the tag goes IMMEDIATELY AFTER `<meta charset>`: a meta CSP governs only what is parsed after
//     it, so it must precede every `<script>`/`<link>` the build emits — and `<meta charset>` itself
//     must stay inside the document's first 1024 bytes, so nothing goes in front of it.
//   - it goes into `index.html` ONLY. `pdf-frame.html` (the second Vite entry, ADR-120) runs inside a
//     `sandbox="allow-scripts"` iframe — an opaque origin where `'self'` matches nothing — so the
//     same policy there would kill the PDF viewer while adding no protection the sandbox does not
//     already give.
//
// Dev is not covered on purpose (Vite's HMR client needs inline evaluation and its own WebSocket;
// the threat model is the developer's own localhost) — `apply: "build"` below.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, sep } from "node:path";
import type { Plugin } from "vite";
import { EXCALIDRAW_ASSET_PATH } from "./excalidraw-asset-path";

/**
 * ADR-277 §Decision item 1, directive by directive. Reasons live in the ADR; the short form:
 *   script-src   `'wasm-unsafe-eval'` for Excalidraw's harfbuzz/emscripten glue — NEVER `'unsafe-eval'`
 *                (a review that shows no violation is not evidence it is unneeded: subsetting runs
 *                in a module worker whose CSP comes from its own response — re-review, not a screenshot).
 *   worker-src   `blob:` for pica's real image-resize worker. Not `data:` — that one is a feature probe
 *                that degrades silently when blocked, and `data:` would be a post-XSS gadget.
 *   style-src    `'unsafe-inline'` for CodeMirror's runtime-positioned widgets (ADR-017).
 *   img/connect  `https:` because the attachment store is a deployment-configured sibling origin
 *                (`s3.<host>`, ADR-233) the build cannot name. `http:` too (2026-09-05, closing
 *                known gap F): a self-host with no TLS terminator in front of it (a plain `http://`
 *                MinIO) presigns `http://` URLs, and `connect-src https:` alone silently killed every
 *                attachment upload against one (measured: `fetch` refused with a CSP violation, no
 *                on-screen error). `script-src`/`object-src`/`base-uri` are unchanged, and `https:` was
 *                already wide open, so this is not a new exfiltration surface — see "what this CSP does
 *                NOT bound" below. This is also why the policy does NOT bound exfiltration — DOMPurify
 *                still does; the ADR says so in as many words.
 *   font-src     `'self' data:`. Excalidraw's fonts are copied into the bundle (see the second plugin),
 *                so the esm.sh fallback it would otherwise reach for is never a fetch — `'self'` alone
 *                would cover the editor. `data:` is for a DIFFERENT consumer: `printBrowserExport`
 *                (exportBrowser.ts) prints through an `iframe.srcdoc`, which inherits the parent
 *                document's CSP, and that document embeds the code face as a `data:font/woff2`
 *                `@font-face` (ADR-194) — without `data:` here the print page silently falls back to a
 *                generic monospace font with no error (review, finding 2).
 *   frame-src    `'self' https:` — for the editor surface this is close to zero protection (the embed
 *                allowlist is judged client-side); `/pub/*` gets a real per-tenant `frame-src` as an
 *                HTTP header from `public-shell.ts`, and header + meta apply as their intersection.
 *   frame-ancestors is not expressible in a meta tag: Caddy's central header block carries it.
 */
export const CSP_DIRECTIVES: ReadonlyArray<readonly [string, string]> = [
  ["default-src", "'self'"],
  ["script-src", "'self' 'wasm-unsafe-eval'"],
  ["worker-src", "'self' blob:"],
  ["style-src", "'self' 'unsafe-inline'"],
  ["img-src", "'self' data: blob: https: http:"],
  ["font-src", "'self' data:"],
  ["connect-src", "'self' wss: https: http:"],
  ["frame-src", "'self' https:"],
  ["object-src", "'none'"],
  ["base-uri", "'self'"],
];

export const CSP_POLICY: string = CSP_DIRECTIVES.map(([name, value]) => `${name} ${value}`).join("; ");

const META_CHARSET = /<meta\s+charset=["']?utf-8["']?\s*\/?>/i;

/** Pure: the tag right after `<meta charset>`, or a throw — a shell without a charset tag is not ours. */
export function injectCspMeta(html: string, policy: string = CSP_POLICY): string {
  const m = META_CHARSET.exec(html);
  if (!m) throw new Error("index.html has no <meta charset=\"utf-8\"> to anchor the CSP tag after");
  const at = m.index + m[0].length;
  return `${html.slice(0, at)}<meta http-equiv="Content-Security-Policy" content="${policy}">${html.slice(at)}`;
}

/** Build-only: inject into `index.html` and nothing else. */
export function cspMetaPlugin(): Plugin {
  return {
    name: "wikistead:csp-meta",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler(html, ctx) {
        // `ctx.filename` is the SOURCE html path; the second entry is pdf-frame.html (see the header).
        if (!/(^|[\\/])index\.html$/.test(ctx.filename)) return html;
        return injectCspMeta(html);
      },
    },
  };
}

// ── Excalidraw fonts, self-hosted ──────────────────────────────────────────────────────────────────
// Excalidraw resolves its font files against `window.EXCALIDRAW_ASSET_PATH` first and falls back to
// `https://esm.sh/@excalidraw/excalidraw@<version>/dist/prod/` — a third-party CDN this product would
// otherwise depend on at runtime, and a `font-src` exception the policy above would otherwise need.
// The package's own `dist/prod/fonts/` tree is copied verbatim into the bundle so the first candidate
// resolves; the app sets the asset path before the module is loaded (`macros/excalidraw.ts`).
// Declared in `./excalidraw-asset-path.ts` (re-exported here for callers of this module) because that
// file must also be importable from BROWSER code, and this one pulls in `node:fs`/`node:module` for
// its Vite plugins.
export { EXCALIDRAW_ASSET_PATH };

/** The package's production entry is `dist/prod/index.js`; its `fonts/` sibling is what ships. */
export function excalidrawProdDir(): string {
  const require = createRequire(import.meta.url);
  return dirname(require.resolve("@excalidraw/excalidraw"));
}
export function excalidrawFontsDir(): string {
  const dir = join(excalidrawProdDir(), "fonts");
  if (!statSync(dir).isDirectory()) throw new Error(`Excalidraw ships no fonts/ beside its entry: ${dir}`);
  return dir;
}

export function listFilesUnder(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(p);
    }
  };
  walk(root);
  return out.sort();
}

/** Build-only: every file under the package's `fonts/` lands at `/excalidraw/fonts/<same path>`. */
export function excalidrawFontsPlugin(): Plugin {
  return {
    name: "wikistead:excalidraw-fonts",
    apply: "build",
    generateBundle() {
      const root = excalidrawFontsDir();
      for (const file of listFilesUnder(root)) {
        const rel = relative(root, file).split(sep).join("/");
        this.emitFile({ type: "asset", fileName: `${EXCALIDRAW_ASSET_PATH.slice(1)}fonts/${rel}`, source: readFileSync(file) });
      }
    },
  };
}
