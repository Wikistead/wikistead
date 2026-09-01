// #990 / ADR-277: the shell's CSP — what it says, where it lands, and what it must never say.
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import {
  CSP_DIRECTIVES, CSP_POLICY, injectCspMeta, cspMetaPlugin, excalidrawFontsDir, excalidrawProdDir, excalidrawFontsPlugin, listFilesUnder, EXCALIDRAW_ASSET_PATH,
} from "../csp-policy";

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

  it("the storage-origin directives are broad, and the hardening pair is present", () => {
    expect(directive("img-src")).toBe("'self' data: blob: https:");
    expect(directive("connect-src")).toBe("'self' wss: https:");
    expect(directive("object-src")).toBe("'none'");
    expect(directive("base-uri")).toBe("'self'");
  });

  it("frame-ancestors is NOT here — a meta tag cannot carry it; Caddy does", () => {
    expect(CSP_POLICY).not.toContain("frame-ancestors");
    expect(CSP_POLICY).not.toContain("report-uri");
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

  it("the asset path the app sets is the directory the plugin emits under", () => {
    expect(EXCALIDRAW_ASSET_PATH).toBe("/excalidraw/");
    expect(existsSync(excalidrawFontsDir())).toBe(true);
  });

  it("excalidraw.ts imports the ONE constant rather than redeclaring its own (finding 3: a second " +
    "literal can drift from this file's without either test noticing)", () => {
    const src = readFileSync(join(dirname(new URL(import.meta.url).pathname), "editor", "macros", "excalidraw.ts"), "utf8");
    expect(src, "no local redeclaration").not.toMatch(/const\s+EXCALIDRAW_ASSET_PATH\s*=/);
    expect(src, "imported from the shared browser-safe module").toMatch(/import\s*\{[^}]*EXCALIDRAW_ASSET_PATH[^}]*\}\s*from\s*["'].*excalidraw-asset-path["']/);
    // Assignment must precede the dynamic import, or the library's first font fetch resolves against
    // esm.sh instead of the self-hosted path.
    const assignAt = src.indexOf("EXCALIDRAW_ASSET_PATH");
    const importAt = src.indexOf('import("@excalidraw/excalidraw")');
    expect(assignAt, "the constant is referenced somewhere").toBeGreaterThan(-1);
    expect(importAt, "the dynamic import exists").toBeGreaterThan(-1);
    expect(assignAt, "referenced before the dynamic import").toBeLessThan(importAt);
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
