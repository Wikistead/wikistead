// #990 / ADR-277: the shell's CSP — what it says, where it lands, and what it must never say.
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import {
  CSP_DIRECTIVES, CSP_POLICY, injectCspMeta, cspMetaPlugin, excalidrawFontsDir, excalidrawProdDir, excalidrawFontsPlugin, listFilesUnder, EXCALIDRAW_ASSET_PATH,
} from "../csp-policy";
import viteConfig from "../vite.config";

const directive = (name: string): string => {
  const hit = CSP_DIRECTIVES.find(([n]) => n === name);
  if (!hit) throw new Error(`no ${name} directive`);
  return hit[1];
};

describe("#990: the policy says what ADR-277 decided", () => {
  it("script-src admits wasm compilation and nothing evaluable — 'unsafe-eval' is a re-review, never a fix", () => {
    expect(directive("script-src")).toBe("'self' 'wasm-unsafe-eval'");
    expect(CSP_POLICY).not.toContain("'unsafe-eval'");
    expect(CSP_POLICY).not.toContain("'unsafe-hashes'");
  });

  it("worker-src admits the blob worker and not data: (the data: worker is a probe that degrades)", () => {
    expect(directive("worker-src")).toBe("'self' blob:");
    expect(directive("worker-src")).not.toContain("data:");
  });

  it("font-src is 'self' plus data: — the fonts ship in the bundle (esm.sh is never a source), and " +
    "data: is for printBrowserExport's srcdoc-inherited @font-face, not a reopened esm.sh escape hatch", () => {
    expect(directive("font-src")).toBe("'self' data:");
    expect(CSP_POLICY).not.toContain("esm.sh");
  });

  it("the storage-origin directives are broad — http: too (a TLS-less self-host must not " +
    "silently lose attachment uploads) — and the hardening pair is present", () => {
    expect(directive("img-src")).toBe("'self' data: blob: https: http:");
    expect(directive("connect-src")).toBe("'self' wss: https: http:");
    expect(directive("object-src")).toBe("'none'");
    expect(directive("base-uri")).toBe("'self'");
  });

  it("frame-ancestors is NOT here — a meta tag cannot carry it; Caddy does", () => {
    expect(CSP_POLICY).not.toContain("frame-ancestors");
    expect(CSP_POLICY).not.toContain("report-uri");
  });
});

describe("#990: the plugins are actually wired into the build (not just correct if reached)", () => {
  it("vite.config.ts's real plugins array carries both — an independent review pass " +
    "found that removing them from the array leaves EVERY test above (and `tsc --noEmit`) green, " +
    "while the shipped index.html silently loses its CSP and Excalidraw silently loses its fonts. " +
    "This reads the actual resolved config object Vite builds with, not vite.config.ts's source text", async () => {
    const resolved = typeof viteConfig === "function"
      ? await (viteConfig as (env: { command: "build"; mode: string }) => unknown)({ command: "build", mode: "production" })
      : viteConfig;
    const plugins = (resolved as { plugins?: unknown[] }).plugins ?? [];
    const names = plugins.flat(Infinity).filter((p): p is { name?: string } => !!p && typeof p === "object").map((p) => p.name);
    expect(names, "cspMetaPlugin (the shell's whole CSP mechanism) is in the build's plugin list").toContain("wikistead:csp-meta");
    expect(names, "excalidrawFontsPlugin (font-src 'self' depends on these files existing) is in the build's plugin list").toContain("wikistead:excalidraw-fonts");
  });
});

describe("#990: where the tag lands", () => {
  const shell = readFileSync(join(dirname(new URL(import.meta.url).pathname), "..", "index.html"), "utf8");

  it("immediately after <meta charset>, before every <link>/<script> the shell has", () => {
    const out = injectCspMeta(shell);
    const csp = out.indexOf('<meta http-equiv="Content-Security-Policy"');
    const charset = out.indexOf('<meta charset="utf-8" />');
    expect(charset, "the charset tag is still first").toBeGreaterThan(-1);
    expect(csp).toBe(charset + '<meta charset="utf-8" />'.length);
    expect(csp, "before the first <link>").toBeLessThan(out.indexOf("<link"));
    expect(csp, "before the first <script>").toBeLessThan(out.indexOf("<script"));
    expect(out).toContain(`content="${CSP_POLICY}"`);
    expect(charset, "and the charset tag stays inside the first 1024 bytes").toBeLessThan(1024);
  });

  it("refuses a document with no charset anchor rather than guessing a position", () => {
    expect(() => injectCspMeta("<html><head><title>x</title></head></html>")).toThrow(/charset/);
  });

  it("the plugin is build-only, and injects into index.html but NOT pdf-frame.html", () => {
    const plugin = cspMetaPlugin();
    expect(plugin.apply).toBe("build");
    const hook = plugin.transformIndexHtml as { handler: (html: string, ctx: { filename: string }) => string };
    const html = '<html><head><meta charset="utf-8" /></head></html>';
    expect(hook.handler(html, { filename: "/x/apps/web/index.html" })).toContain("Content-Security-Policy");
    expect(hook.handler(html, { filename: "/x/apps/web/pdf-frame.html" }), "the opaque-origin frame keeps its sandbox as its only policy").toBe(html);
  });
});

describe("#990: Excalidraw's fonts really are in the bundle's reach", () => {
  it("every font URI the shipped Excalidraw build references exists under the directory the plugin copies", () => {
    const root = excalidrawFontsDir();
    const files = new Set(listFilesUnder(root).map((f) => f.slice(root.length + 1)));
    expect(files.size, "the package ships fonts").toBeGreaterThan(50);
    // The URIs live in the package's own chunks as `./fonts/<family>/<file>.woff2`.
    const prod = excalidrawProdDir();
    const referenced = new Set<string>();
    for (const chunk of listFilesUnder(prod).filter((f) => f.endsWith(".js"))) {
      for (const m of readFileSync(chunk, "utf8").matchAll(/"\.\/fonts\/([^"]+\.woff2)"/g)) referenced.add(m[1]!);
    }
    expect(referenced.size, "the build names its fonts (the detector is not vacuous)").toBeGreaterThan(10);
    const missing = [...referenced].filter((r) => !files.has(r));
    expect(missing, "a referenced font the copy would not carry").toEqual([]);
  });

  // review + ruling: the PREVIOUS version of this describe block only asserted that
  // every referenced font FILE exists under the copied directory — it never looked at what the shipped
  // library's own URL-resolution algorithm actually DOES with `window.EXCALIDRAW_ASSET_PATH`, so it
  // stayed green while a real Chromium run showed 0/230 self-hosted font requests and 230/230 landing
  // on esm.sh. Verified live (2026-09-05) against the REAL production nginx.conf + a real dist build in
  // a real `nginx:alpine` container (not a hand-rolled test-harness static server, which is what the
  // review's own probe used and where the fallback-masking bug actually lived): with the shipped
  // files served correctly, 4/4 font fetches hit `/excalidraw/fonts/...` and esm.sh saw zero requests —
  // the library's resolution order is correct. This test reads that SAME shipped algorithm's source
  // text (not a self-computed `origin + ASSET_PATH`, the flaw named) and pins its actual order:
  // `EXCALIDRAW_ASSET_PATH` is checked and a candidate URL is queued BEFORE `ASSETS_FALLBACK_URL` (the
  // esm.sh constant) is ever referenced. A future version of the library that drops the self-host check,
  // or reorders the fallback ahead of it, fails this without needing a browser at all.
  it("the shipped library's own resolver checks EXCALIDRAW_ASSET_PATH and queues a candidate URL for it BEFORE it ever reaches for the esm.sh fallback constant", () => {
    const prod = excalidrawProdDir();
    const hits: { chunk: string; gap: number }[] = [];
    for (const chunk of listFilesUnder(prod).filter((f) => f.endsWith(".js"))) {
      const src = readFileSync(chunk, "utf8");
      const fallbackDeclaredAt = src.indexOf("ASSETS_FALLBACK_URL");
      if (fallbackDeclaredAt === -1) continue; // not the chunk with the resolver — most chunks aren't
      const checksAssetPath = src.indexOf("typeof window.EXCALIDRAW_ASSET_PATH");
      expect(checksAssetPath, `${chunk} names ASSETS_FALLBACK_URL but never checks EXCALIDRAW_ASSET_PATH — the self-host branch is gone`).toBeGreaterThan(-1);
      // Both terms live in ONE small static method (~500 chars in the version this was written
      // against) — a generous window rules out matching unrelated code that happens to mention either
      // string somewhere else in a 1MB+ minified chunk.
      const fallbackUsedAfterCheck = src.indexOf("ASSETS_FALLBACK_URL", checksAssetPath);
      expect(fallbackUsedAfterCheck, "the fallback constant must appear (as code, not just declared) after the EXCALIDRAW_ASSET_PATH check — never before it").toBeGreaterThan(checksAssetPath);
      const gap = fallbackUsedAfterCheck - checksAssetPath;
      expect(gap, "the two must be part of the same small resolver method, not coincidentally far apart in the bundle").toBeLessThan(800);
      // The self-hosted branch must actually QUEUE a URL (push to the candidate array), not merely
      // reference the identifier in a comment or an unrelated branch.
      const between = src.slice(checksAssetPath, fallbackUsedAfterCheck);
      expect(between, "a URL must be constructed for the self-hosted candidate between the check and the fallback").toMatch(/push\(new URL\(/);
      hits.push({ chunk, gap });
    }
    expect(hits.length, "exactly one shipped chunk should contain this resolver").toBe(1);
  });

  it("the asset path the app sets is the directory the plugin emits under", () => {
    expect(EXCALIDRAW_ASSET_PATH).toBe("/excalidraw/");
    expect(existsSync(excalidrawFontsDir())).toBe(true);
  });

  it("excalidraw.ts imports the ONE constant rather than redeclaring its own (finding 3: a second " +
    "literal can drift from this file's without either test noticing)", () => {
    const src = readFileSync(join(dirname(new URL(import.meta.url).pathname), "editor", "macros", "excalidraw.ts"), "utf8");
    expect(src, "no local redeclaration").not.toMatch(/const\s+EXCALIDRAW_ASSET_PATH\s*=/);
    expect(src, "imported from the shared browser-safe module").toMatch(/import\s*\{[^}]*EXCALIDRAW_ASSET_PATH[^}]*\}\s*from\s*["'].*excalidraw-asset-path["']/);
    // The RUNTIME assignment (not just any mention of the identifier — an independent review
    // pass found `indexOf("EXCALIDRAW_ASSET_PATH")` above matches the IMPORT statement first,
    // so deleting the actual `window.EXCALIDRAW_ASSET_PATH ??= …` line, or moving it after the dynamic
    // import, left this assertion green) must precede the dynamic import, or the library's first font
    // fetch resolves against esm.sh instead of the self-hosted path.
    const assignMatch = /\.EXCALIDRAW_ASSET_PATH\s*\?\?=\s*EXCALIDRAW_ASSET_PATH\s*;/.exec(src);
    // NOT src.indexOf('import("@excalidraw/excalidraw")') alone — line 18's `Promise<typeof
    // import("@excalidraw/excalidraw")>` type position matches that same substring, is erased at
    // compile time (never actually fetches anything), and sits BEFORE the real runtime call, which
    // made an earlier version of this assertion pass regardless of where the assignment moved. Anchor
    // on `Promise.all([import(...` — the actual call `loadExcalidraw` awaits.
    const importMatch = /Promise\.all\(\[\s*import\("@excalidraw\/excalidraw"\)/.exec(src);
    expect(assignMatch, "the window.EXCALIDRAW_ASSET_PATH ??= assignment exists").not.toBeNull();
    expect(importMatch, "the real (runtime) dynamic import call exists").not.toBeNull();
    expect(assignMatch!.index, "the assignment runs before the dynamic import call").toBeLessThan(importMatch!.index);
  });

  it("every file the plugin emits lands where Excalidraw's own URL-resolution algorithm will look for it " +
    "(finding 3: the previous pin matched a comment, not the emitted paths — this drives the real " +
    "generateBundle hook through a stub emitFile and recomputes the target with the WHATWG URL algorithm, " +
    "independently of the template string the plugin uses to build fileName)", () => {
    const emitted: string[] = [];
    const ctx = { emitFile: (f: { fileName?: string }) => { if (f.fileName) emitted.push(f.fileName) } };
    const plugin = excalidrawFontsPlugin();
    (plugin.generateBundle as unknown as (this: typeof ctx) => void).call(ctx);
    expect(emitted.length, "the stub actually captured emitted assets").toBeGreaterThan(50);
    const origin = "https://shell.example";
    for (const fileName of emitted) {
      expect(fileName.startsWith(`${EXCALIDRAW_ASSET_PATH.slice(1)}fonts/`)).toBe(true);
      const relFromFontsDir = fileName.slice(`${EXCALIDRAW_ASSET_PATH.slice(1)}fonts/`.length);
      const resolved = new URL(`./fonts/${relFromFontsDir}`, `${origin}${EXCALIDRAW_ASSET_PATH}`);
      expect(resolved.pathname).toBe(`/${fileName}`);
    }
  });
});
