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
        VITE_API_URL: "/api",
        VITE_COLLAB_URL: "/collab",
        VITE_DEV_TOKEN: "dev-token", // member specs use the dev bypass (login.spec covers real OIDC)
        API_PROXY_TARGET: "http://localhost:4010",
        COLLAB_PROXY_TARGET: "http://localhost:4110",
      },
    },
  ],
});
