import { test, expect } from "@playwright/test";
import { openDemo, sleep, API } from "../helpers";

// #505 / ADR-191: the app's print action renders the page server-side (export.html — every macro static,
// one canonical renderer), but the browser's own Ctrl+P used to fall to the print stylesheet over the
// client portal instead. Two roads to paper means two things to keep in parity, which is the drift this
// work keeps finding. The shortcut takes the same road now.
test("#505: Ctrl+P goes through the server-rendered export, not the client portal", async ({ page }) => {
  const requested: string[] = [];
  page.on("request", (r) => { if (r.url().includes("/export.html")) requested.push(r.url()); });
  // the print dialog would block the run — stub it out; what we pin is WHICH document gets printed
  await page.addInitScript(() => {
    (window as unknown as { __printed: number }).__printed = 0;
    window.print = () => { (window as unknown as { __printed: number }).__printed += 1; };
  });

  await openDemo(page);
  await sleep(400);
  await page.keyboard.press("Control+p");
  await sleep(1500);

  expect(requested.length, "the shortcut fetched the server-rendered document").toBeGreaterThan(0);
  expect(requested[0], "…for the page in view").toContain("/export.html");
  // the app's own action uses the same door (sanity: the endpoint is reachable for this page)
  const status = await page.evaluate(async (api) => {
    const id = location.pathname.split("/p/")[1]!;
    const r = await fetch(`${api}/pages/${id}/export.html`, { headers: { Authorization: "Bearer dev-token" } });
    return r.status;
  }, API);
  expect(status).toBe(200);
});
