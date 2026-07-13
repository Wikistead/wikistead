import { test, expect } from "@playwright/test";
import { openScratch, enterEdit, sleep } from "../helpers";

// #304 + #345 the member editor's TOC rail scroll-spy, now a TWO-LAYER highlight. (1) A jumped-to heading
// is the CURRENT (dark, data-active) item under a TALL (2-line) band. (2 → #345) The old bottom CLAMP is gone: a
// short final section is covered by the LIGHT layer (data-visible = on screen) instead of being forced dark. (4)
// The rail grows into the right whitespace. Real Chromium, wide viewport, a deliberately LONG page title.
const LONG_TITLE = "A deliberately very long page title that wraps onto two lines in the frosted header band";

test("#304/#345: TOC jump = dark active under a 2-line band; the short last section is LIGHT-visible; elastic rail", async ({ browser }) => {
  const page = await (await browser.newContext({ viewport: { width: 1360, height: 720 } })).newPage();
  await openScratch(page, LONG_TITLE);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  const filler = (n: string) => Array.from({ length: 20 }, (_, i) => `${n} paragraph ${i} lorem ipsum dolor sit amet consectetur.`).join("\n\n");
  await page.keyboard.insertText(
    `# Alpha Heading\n\n${filler("A")}\n\n# Bravo Heading\n\n${filler("B")}\n\n# Charlie Heading\n\n${filler("C")}\n\n# Delta Heading\n\nshort tail\n`,
  );
  await sleep(600);

  // the band wrapped to (at least) 2 lines → taller than the old fixed 48px sample offset.
  const bandH = await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector(".cm-content")!).paddingTop) || 0);
  expect(bandH, `band height ${bandH} should exceed the old 48px sampler`).toBeGreaterThan(48);

  const rail = page.locator("[data-testid=toc][data-variant=rail]");
  await expect(rail).toBeVisible({ timeout: 8000 });
  const items = rail.getByTestId("toc-item");
  await expect(items).toHaveCount(4);

  // (4) elastic width — grows past the old fixed 210px in the wide right whitespace.
  const railW = await rail.evaluate((el) => el.getBoundingClientRect().width);
  expect(railW, `rail width ${railW} should exceed the old fixed 210px`).toBeGreaterThan(210);

  // (1) click "Charlie" → THE CLICKED item is the dark active (not Bravo, the old off-by-one under a tall band).
  // #345: jump-intent — Charlie stays active through the programmatic jump scroll (only a real user scroll moves it).
  await items.nth(2).click();
  await sleep(500);
  await expect(items.nth(2)).toHaveAttribute("data-active", "");
  await expect(items.nth(1)).not.toHaveAttribute("data-active", "");

  // (2 → #345) scroll to the very bottom (a REAL wheel releases the jump pin) → the short final section
  // ("Delta") is on screen, so it's LIGHT-visible (data-visible). The dark clamp is gone.
  await page.locator(".cm-scroller").evaluate((el) => {
    el.dispatchEvent(new WheelEvent("wheel", { bubbles: true })); // user-scroll intent → release the jump pin
    el.scrollTop = el.scrollHeight;
  });
  await sleep(400);
  await expect(items.nth(3)).toHaveAttribute("data-visible", "");

  // (3 → #345) click the SHORT final section ("Delta") → jump-intent lights IT (dark), not a neighbour.
  // The old clamp/sample would light the last item on any bottom scroll; here the CLICKED item is pinned dark.
  await items.nth(3).click();
  await sleep(500);
  await expect(items.nth(3)).toHaveAttribute("data-active", "");
  await expect(items.nth(2)).not.toHaveAttribute("data-active", "");
});
