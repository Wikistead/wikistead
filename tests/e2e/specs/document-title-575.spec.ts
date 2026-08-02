import { test, expect } from "@playwright/test";
import { API, openDemo } from "../helpers";

// #575 slice C: the browser tab carries the workspace's name.
//
// `index.html` is served before any tenant is known, so its <title> can only be a static fallback —
// ADR-200 rev3 says so, and that is why the app sets it once branding resolves. Before this, every
// tab said "Wikistead" whatever the workspace was called.
//
// The first version of this spec was VACUOUS: it compared the tab against the resolved brand name,
// and this tenant's display name happens to BE the shell's literal, so removing the hook kept it
// green. It renames the workspace first, which is the only way the two can differ.
const NAME = `Tab Check ${Date.now().toString(36)}`;

test("#575: the tab title follows the workspace name, not the static shell", async ({ page }) => {
  await openDemo(page);
  const before = await page.evaluate(async (api) => {
    const r = await fetch(`${api}/branding`, { headers: { Authorization: "Bearer dev-token" } });
    return ((await r.json()) as { displayName: string | null }).displayName;
  }, API);
  try {
    await page.evaluate(async ({ api, name }) => {
      await fetch(`${api}/tenant/branding`, {
        method: "PATCH", headers: { Authorization: "Bearer dev-token", "content-type": "application/json" },
        body: JSON.stringify({ displayName: name }),
      });
    }, { api: API, name: NAME });
    await page.reload();
    await expect.poll(async () => await page.title(), { timeout: 10_000 }).toBe(NAME);
  } finally {
    await page.evaluate(async ({ api, name }) => {
      await fetch(`${api}/tenant/branding`, {
        method: "PATCH", headers: { Authorization: "Bearer dev-token", "content-type": "application/json" },
        body: JSON.stringify({ displayName: name }),
      });
    }, { api: API, name: before });
  }
});
