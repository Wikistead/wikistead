import { defineConfig } from "@playwright/test";

// E2E runs against the isolated e2e middleware (docker-compose.e2e.yml, started
// by `pnpm setup:e2e`). Playwright starts the three app processes on dedicated
// ports via webServer, pointed at that middleware through .env.e2e(.local).
const REPO = new URL("../../", import.meta.url).pathname;
const ENV_FILES = "--env-file=.env.e2e --env-file=.env.e2e.local";

export default defineConfig({
  testDir: "./specs",
  fullyParallel: false, // shared collab doc / fixtures => run serially
  workers: 1,
  timeout: 60_000,
  globalSetup: "./global-setup.ts",
  reporter: [["list"]],
  use: {
    // Same-origin (ADR-016): the browser hits the web origin only; Vite proxies
    // /api + /collab. dev.localhost (not localhost) so the API resolves slug "dev".
    baseURL: "http://dev.localhost:5180",
    channel: "chrome", // system Chrome — no browser download
    headless: true,
    launchOptions: { args: ["--no-sandbox"] },
    trace: "off",
  },
  webServer: [
    {
      command: `npx tsx ${ENV_FILES} apps/server/src/index.ts`,
      cwd: REPO,
      url: "http://localhost:4010/healthz",
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        // Platform IdP (Cloud signup + login fallback) — the fixed-port issuer from
        // globalSetup. Tenant subdomains for created workspaces point at the
        // real-mode web (5181) so SSO seating is exercised in a real browser.
        PLATFORM_OIDC_ISSUER: "http://127.0.0.1:4444",
        PLATFORM_OIDC_CLIENT_ID: "e2e-client",
        PLATFORM_OIDC_REDIRECT_URI: "http://dev.localhost:5181/signup/callback",
        PUBLIC_TENANT_BASE_HOST: "localhost:5181",
      },
    },
    {
      command: `npx tsx ${ENV_FILES} apps/collab/src/index.ts`,
      cwd: REPO,
      url: "http://localhost:4110/",
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: "npx vite --port 5180 --strictPort",
      cwd: `${REPO}apps/web`,
      url: "http://localhost:5180",
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        WEB_PORT: "5180",
        // Same-origin: relative URLs go through the Vite proxy to the e2e ports.
        // Dev-token bypass comes from .env.development (mode=development); the member
        // specs use it. login.spec/signup.spec cover the real OIDC paths.
        VITE_API_URL: "/api",
        VITE_COLLAB_URL: "/collab",
        API_PROXY_TARGET: "http://localhost:4010",
        COLLAB_PROXY_TARGET: "http://localhost:4110",
      },
    },
    {
      // REAL-mode web (no dev-token) — for signup.spec, which verifies the real
      // browser flow: platform signup → tenant → SSO seating with a host-only
      // member session on the new subdomain.
      // --mode realauth loads .env.realauth (VITE_DEV_TOKEN empty) → real auth mode.
      command: "npx vite --port 5181 --strictPort --mode realauth",
      cwd: `${REPO}apps/web`,
      url: "http://localhost:5181",
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        WEB_PORT: "5181",
        VITE_API_URL: "/api",
        VITE_COLLAB_URL: "/collab",
        API_PROXY_TARGET: "http://localhost:4010",
        COLLAB_PROXY_TARGET: "http://localhost:4110",
      },
    },
  ],
});
