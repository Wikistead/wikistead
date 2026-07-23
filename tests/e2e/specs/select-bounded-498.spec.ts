import { test, expect } from "@playwright/test";
import { sleep } from "../helpers";

// #498: the DS Select must open a BOUNDED popper below its trigger. Radix's "item-aligned" mode (the old
// default) overlays the trigger and EXPANDS as you wheel-scroll, so a long option list grew until it
// filled the viewport. Pinned on a real long list (30 spaces in the assign-space select): the popup is
// anchored under the trigger, never taller than the viewport, and wheel-scrolling scrolls INSIDE it
// without growing the box.
const API = "http://dev.localhost:4010";
const H = { Authorization: "Bearer dev-token", "content-type": "application/json" };

test("#498: the select dropdown stays bounded and scrolls inside, instead of growing to the viewport", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await page.goto("/p/demo");
  await page.waitForSelector("[data-pane=preview] .cm-content");

  // guarantee a LONG list: 30 spaces + a resource role to unlock the assign-space select
  const roleName = `sel498-${Date.now().toString(36)}`;
  await page.evaluate(async ({ api, roleName }) => {
    const H = { Authorization: "Bearer dev-token", "content-type": "application/json" };
    for (let i = 0; i < 30; i++) {
      await fetch(`${api}/spaces`, { method: "POST", headers: H, body: JSON.stringify({ name: `sel498-sp${String(i).padStart(2, "0")}` }) });
    }
    await fetch(`${api}/admin/roles`, { method: "POST", headers: H, body: JSON.stringify({ name: roleName, capabilities: ["view"], scope: "resource" }) });
  }, { api: API, roleName });

  await page.goto("/admin/roles");
  await expect(page.getByTestId("admin-roles")).toBeVisible({ timeout: 10000 });
  await page.getByTestId("assign-role").click();
  await page.getByRole("option", { name: roleName }).click();
  const trigger = page.getByTestId("assign-space");
  await expect(trigger).toBeEnabled({ timeout: 8000 });
  await trigger.click();

  const content = page.locator("[data-slot=select-content]");
  await expect(content).toBeVisible({ timeout: 8000 });
  const viewport = page.viewportSize()!;
  const trigBox = (await trigger.boundingBox())!;
  const before = (await content.boundingBox())!;

  // bounded: inside the viewport, and anchored to a SIDE of the trigger (popper — below, or flipped above
  // when there is no room below), never OVERLAYING it the way item-aligned does
  expect(before.height, "popup no taller than the viewport").toBeLessThanOrEqual(viewport.height + 1);
  const below = before.y >= trigBox.y + trigBox.height - 2;
  const above = before.y + before.height <= trigBox.y + 2;
  expect(below || above, `popup sits beside the trigger, not over it (trigger ${trigBox.y}-${trigBox.y + trigBox.height}, popup ${before.y}-${before.y + before.height})`).toBe(true);

  // wheel-scrolling scrolls INSIDE the popup and the box stays BOUNDED. (Exact height equality is not
  // asserted: once the inner list bottoms out, scroll chaining moves the page and popper legitimately
  // re-measures its available height — bounded and non-overlaying is the invariant, growing past the
  // viewport was the bug.)
  await content.hover();
  for (let i = 0; i < 3; i++) { await page.mouse.wheel(0, 160); await sleep(80); }
  const after = (await content.boundingBox())!;
  expect(after.height, `still bounded after scrolling (was ${before.height}, now ${after.height})`).toBeLessThanOrEqual(viewport.height + 1);
  // and it actually scrolled content (the viewport inside moved) — the list is long enough to need it
  const scrolled = await content.evaluate((el) => {
    const vp = el.querySelector("[data-radix-select-viewport]") as HTMLElement | null;
    return vp ? vp.scrollTop : -1;
  });
  expect(scrolled, "the list scrolled inside the bounded popup").toBeGreaterThan(0);
});
