import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    // `@/…` → src/… (shadcn convention). Existing relative imports keep working.
    alias: { "@": new URL("./src", import.meta.url).pathname },
  },
  // #273 / ADR-120 (Option B): a SECOND HTML entry (pdf-frame.html) that runs pdf.js. The attachment PDF
  // viewer embeds it in a `sandbox="allow-scripts"` (NO allow-same-origin) iframe = an OPAQUE origin, and
  // posts the PDF bytes in. pdf.js + its worker are code-split into this entry, so ONLY a page that inlines a
  // PDF pays the cost (lazy by nature — the iframe is created only for a sniffed PDF).
  build: {
    rollupOptions: {
      input: {
        main: new URL("./index.html", import.meta.url).pathname,
        "pdf-frame": new URL("./pdf-frame.html", import.meta.url).pathname,
      },
    },
  },
  // Same-origin model (ADR-016): the browser only talks to the web origin; /api and
  // /collab are proxied to the API and collab services so the BFF session cookie
  // (host-only) is sent to them. changeOrigin:false PRESERVES the Host header so the
  // API still resolves the tenant from it (dev.localhost → slug "dev"). This mirrors
  // the production reverse-proxy path-split (dev/prod parity). Targets are env-driven
  // so the e2e harness can point at its own ports.
  server: {
    port: Number(process.env.WEB_PORT ?? 5173),
    // #273 the PDF viewer's iframe is `sandbox="allow-scripts"` (no allow-same-origin) = an OPAQUE
    // origin, whose document fetches its `<script type="module">` (and its imports) in CORS mode with
    // `Origin: null`. Without an ACAO header the frame's pdf-frame entry is blocked and never runs ("Loading…"
    // forever). Serve every dev asset with `Access-Control-Allow-Origin: *` so the opaque frame can load its
    // own same-file module chunk. No credentials ride these public static assets, so the sandbox containment
    // (no allow-same-origin) is NOT weakened. PROD must serve the pdf-frame chunk/assets with the same header.
    headers: { "Access-Control-Allow-Origin": "*" },
    proxy: {
      "/api": {
        target: process.env.API_PROXY_TARGET ?? "http://localhost:4000",
        changeOrigin: false,
        rewrite: (p) => p.replace(/^\/api/, ""),
      },
      // /auth/* and /signup/* are TOP-LEVEL navigation flows (login/signup → IdP →
      // callback), so their path must be preserved end-to-end (NO prefix strip) —
      // the OIDC redirect_uri the browser sees must equal what the server
      // reconstructs. (The SPA's own signup pages live under /join, not /signup.)
      "/auth": {
        target: process.env.API_PROXY_TARGET ?? "http://localhost:4000",
        changeOrigin: false,
      },
      "/signup": {
        target: process.env.API_PROXY_TARGET ?? "http://localhost:4000",
        changeOrigin: false,
      },
      "/collab": {
        target: process.env.COLLAB_PROXY_TARGET ?? "http://localhost:4100",
        ws: true,
        changeOrigin: false,
        rewrite: (p) => p.replace(/^\/collab/, ""),
      },
      // #441 / ADR-154 §4: robots + sitemap are SERVER routes (the #253 public switch gates them);
      // without the proxy the dev browser got the SPA index.html. /pub deliberately stays the plain
      // SPA in dev (ADR-154 §1) — only these two crawler files route through.
      "/robots.txt": {
        target: process.env.API_PROXY_TARGET ?? "http://localhost:4000",
        changeOrigin: false,
      },
      "/sitemap.xml": {
        target: process.env.API_PROXY_TARGET ?? "http://localhost:4000",
        changeOrigin: false,
      },
    },
  },
});
