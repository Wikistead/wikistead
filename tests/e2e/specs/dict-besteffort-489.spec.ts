import { test, expect, type Page } from "@playwright/test";
import { openScratch, enterEdit, sleep } from "../helpers";

// #489 (remedy 1 + HAR fact 2) — the client side of "the dictionary must never take the app
// down": a dict failure is NOT retried in the foreground (the HAR showed retry:1 doubling one 3.2s
// deadline-500 into ~6.5s of freeze), and the /published poll STOPS once a page id has 404'd (the HAR
// showed it polling a dead id forever). Both pinned by counting real requests over a window.

test("#489: a failing title-dictionary is fetched ONCE — no foreground retry", async ({ browser }) => {
  const page: Page = await (await browser.newContext()).newPage();
  let dictCalls = 0;
  await page.route(/\/title-dictionary(\?|$)/, (r) => {
    dictCalls++;
    return r.fulfill({ status: 500, contentType: "application/json", body: '{"error":"deadline"}' });
  });
  await openScratch(page, "dict-489");
  await enterEdit(page); // the dictionary hook mounts twice on this flow: the view surface, then the editor
  await sleep(4000); // the old retry:1 fired each mount's second request well within this window
  // One fetch PER MOUNT (view + editor = 2) and nothing more — the failure is never retried in the
  // foreground. RED before the fix: 4 (each of the two mounts retried its failed fetch once).
  expect(dictCalls, "one fetch per mount, no retries (RED before: 4)").toBe(2);
  // …and the surface stayed usable (the editor is up; links just render plain)
  await expect(page.locator("[data-pane=preview] .cm-content")).toBeVisible();
});

test("#489: the /published poll STOPS after the page id 404s", async ({ browser }) => {
  const page: Page = await (await browser.newContext()).newPage();
  let pubCalls = 0;
  page.on("response", (r) => {
    if (/\/pages\/no-such-489-poll\/published(\?|$)/.test(r.url())) pubCalls++;
  });
  await page.goto("/p/no-such-489-poll");
  await sleep(2500); // initial fetch + the default retry land here
  const early = pubCalls;
  expect(early).toBeGreaterThanOrEqual(1);
  await sleep(6000); // 4 poll ticks (1.5s interval) would fire in this window before the fix
  expect(pubCalls, "no further polls after the confirmed 404 (RED before: keeps polling every 1.5s)").toBe(early);
});
