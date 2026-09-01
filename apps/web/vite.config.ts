import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
// #724 / ADR-231: the dev proxy is BUILT from the one origin route table, not written beside it.
// Three hand-kept copies of this mapping (here, Caddy, the ingress) drifted until a deployed stack
// answered 404 to every api call and sign-in could not start; dev never noticed because dev IS this
// file. Now a row added for production is a row the dev browser gets too.
import { PROXIED_ROUTES } from "../../infra/routes/origin-routes.mjs";
// #990 / ADR-277: the app shell's CSP rides the built index.html as a meta tag (build only), and
// Excalidraw's fonts are copied into the bundle so the policy needs no third-party font origin.
import { cspMetaPlugin, excalidrawFontsPlugin } from "./csp-policy";

const SERVER_TARGET = () => process.env.API_PROXY_TARGET ?? "http://localhost:4000";
const COLLAB_TARGET = () => process.env.COLLAB_PROXY_TARGET ?? "http://localhost:4100";

const devProxy = Object.fromEntries(
  PROXIED_ROUTES.map((r) => [
    r.path,
    {
      target: r.upstream === "collab" ? COLLAB_TARGET() : SERVER_TARGET(),
      // Host is PRESERVED so the API still resolves the tenant from it (dev.localhost → "dev").
      changeOrigin: false,
      ...(r.ws ? { ws: true } : {}),
      // Only /api is stripped, and the table says so — the same column the edge configs are
      // checked against, so dev and production cannot disagree about it again.
      ...(r.strip ? { rewrite: (p: string) => p.slice(r.path.length) || "/" } : {}),
    },
  ]),
);

export default defineConfig({
  plugins: [react(), tailwindcss(), cspMetaPlugin(), excalidrawFontsPlugin()],
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
    proxy: devProxy,
  },
});
