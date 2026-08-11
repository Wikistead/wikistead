import { defineConfig } from "@playwright/test";
// @ts-expect-error — repo-root JS helper, no types
import { e2ePorts } from "../../scripts/stack-offset.mjs";
// @ts-expect-error — repo-root JS helper, no types
import { eeServerMain } from "../../scripts/ee-source-root.mjs";

// E2E runs against the isolated e2e middleware (docker-compose.e2e.yml, started
// by `pnpm setup:e2e`). Playwright starts the app processes on dedicated ports via
// webServer, pointed at that middleware through .env.e2e(.local).
//
// #484 slice 2: every port here is derived from WKS_STACK_OFFSET so a/b/c can run
// isolated e2e stacks. Offset 0 (unset) reproduces the original literals exactly.
// The app processes get their CONNECTION env (DATABASE_URL, OPENFGA_API_URL, …)
// from .env.e2e.local, which `setup:e2e` writes with this stack's offset URLs; the
// LISTEN ports + proxy targets + baseURL come from the same port map below.
const P = e2ePorts();
const REPO = new URL("../../", import.meta.url).pathname;
const ENV_FILES = "--env-file=.env.e2e --env-file=.env.e2e.local";
const HOST = "dev.localhost";

// #178 / ADR-084: the EE composition root's location is mid-move (packages/ee-server → ee/ overlay),
// so it is RESOLVED, not hard-coded. Null means a genuinely CE-only clone: run the CE entrypoint, and
// say so — an overlay that exists but drifted THROWS in the resolver instead of degrading to this.
const SERVER_ENTRY = eeServerMain(REPO) ?? `${REPO}apps/server/src/index.ts`;
if (!eeServerMain(REPO)) console.warn("[e2e] no EE source found — running the CE-only composition root");

export default defineConfig({
  testDir: "./specs",
  fullyParallel: false, // shared collab doc / fixtures => run serially
  workers: 1,
  timeout: 60_000,
  globalSetup: "./global-setup.ts",
  globalTeardown: "./global-teardown.ts", // #279: fail a run that broke the shared demo FGA fixture
  reporter: [["list"]],
  use: {
    // Same-origin (ADR-016): the browser hits the web origin only; Vite proxies
    // /api + /collab. dev.localhost (not localhost) so the API resolves slug "dev".
    baseURL: `http://${HOST}:${P.web}`,
    channel: "chrome", // system Chrome — no browser download
    headless: true,
    launchOptions: { args: ["--no-sandbox"] },
    trace: "off",
  },
  webServer: [
    {
      // #178 / ADR-084: run the EE composition root (main.ts, wherever the resolver finds it) so the
      // e2e stack exercises the SHIPPING EE build (SCIM etc. mounted via the seam), not the CE-only
      // server — except in a CE-only clone, where the CE entrypoint is all there is.
      // --conditions=source makes @wikistead/server/ee-host resolve to its TS source (tsx), matching how
      // apps/server ran from source before the split (no dist build needed for the dev/e2e server).
      // SERVER_PORT comes from .env.e2e.local (offset); healthz is polled on the same derived port.
      command: `npx tsx --conditions=source ${ENV_FILES} ${SERVER_ENTRY}`,
      cwd: REPO,
      url: `http://localhost:${P.server}/healthz`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        // Platform IdP (Cloud signup + login fallback) — the fixed-port issuer from
        // globalSetup. Tenant subdomains for created workspaces point at the
        // real-mode web so SSO seating is exercised in a real browser.
        PLATFORM_OIDC_ISSUER: `http://127.0.0.1:${P.issuer}`,
        PLATFORM_OIDC_CLIENT_ID: "e2e-client",
        PLATFORM_OIDC_REDIRECT_URI: `http://${HOST}:${P.webReal}/signup/callback`,
        PUBLIC_TENANT_BASE_HOST: `localhost:${P.webReal}`,
      },
    },
    {
      command: `npx tsx ${ENV_FILES} apps/collab/src/index.ts`,
      cwd: REPO,
      url: `http://localhost:${P.collab}/`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: `npx vite --port ${P.web} --strictPort`,
      cwd: `${REPO}apps/web`,
      url: `http://localhost:${P.web}`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        WEB_PORT: String(P.web),
        // Same-origin: relative URLs go through the Vite proxy to the e2e ports.
        // Dev-token bypass comes from .env.development (mode=development); the member
        // specs use it. login.spec/signup.spec cover the real OIDC paths.
        VITE_API_URL: "/api",
        VITE_COLLAB_URL: "/collab",
        API_PROXY_TARGET: `http://localhost:${P.server}`,
        COLLAB_PROXY_TARGET: `http://localhost:${P.collab}`,
      },
    },
    {
      // REAL-mode web (no dev-token) — for signup.spec, which verifies the real
      // browser flow: platform signup → tenant → SSO seating with a host-only
      // member session on the new subdomain.
      // --mode realauth loads .env.realauth (VITE_DEV_TOKEN empty) → real auth mode.
      command: `npx vite --port ${P.webReal} --strictPort --mode realauth`,
      cwd: `${REPO}apps/web`,
      url: `http://localhost:${P.webReal}`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        WEB_PORT: String(P.webReal),
        VITE_API_URL: "/api",
        VITE_COLLAB_URL: "/collab",
        API_PROXY_TARGET: `http://localhost:${P.server}`,
        COLLAB_PROXY_TARGET: `http://localhost:${P.collab}`,
      },
    },
  ],
});
