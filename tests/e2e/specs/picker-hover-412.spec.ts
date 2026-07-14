import { test, expect, type Page } from "@playwright/test";
import { openScratch, createScratchPage, enterEdit, sleep } from "../helpers";

// #412: picker pointer-interaction regressions. The reported device bug: right after opening the [[
// picker, mouse clicks were dead until one Ctrl-j. The app-side pathology (reproduced here, red pre-fix):
// hover-selection was yanked back to the first hit by the auto-select effect, because only KEYBOARD
// nav pinned userNavRef — pointer movement over the list now pins it too. C/D drive realistic pointer
// sequences straight through to a confirmed pick.
const srcText = async (p: Page) => {
  await p.getByTestId("displaymode-source").click();
  await sleep(250);
  return p.locator("[data-pane=preview] .cm-content").innerText();
};

// E: hovering a row must MOVE the highlight to it and KEEP it there (pre-fix, the auto-select
// effect yanks the selection back to the first hit because only KEYBOARD nav pinned userNavRef).
test("#412: hovering a non-first hit keeps it highlighted (no auto-select yank)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await page.goto("/p/demo");
  await page.waitForSelector("[data-pane=preview] .cm-content");
  await createScratchPage(page, "Repro412E One");
  await createScratchPage(page, "Repro412E Two");

  await openScratch(page, "repro412-e");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.type("see [[");
  await expect(page.getByTestId("embed-picker-input")).toBeVisible();
  await page.getByTestId("embed-picker-input").fill("Repro412E");
  const items = page.getByTestId("embed-picker-item");
  await expect(items.nth(1)).toBeVisible({ timeout: 10000 });
  await expect(items.first()).toHaveAttribute("aria-selected", "true"); // auto-select of the first hit
  await items.nth(1).hover();
  await sleep(250); // let any (buggy) revert effect run
  await expect(items.nth(1)).toHaveAttribute("aria-selected", "true"); // the hovered row stays highlighted
  await expect(items.first()).toHaveAttribute("aria-selected", "false");
});

// C: the mouse HOVERS across items first (multiple pointermoves — the auto-select revert fight),
// then clicks the hovered item.
test("#412: hover across items (pointermove storm), then click the hovered one", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await page.goto("/p/demo");
  await page.waitForSelector("[data-pane=preview] .cm-content");
  await createScratchPage(page, "Repro412C One");
  await createScratchPage(page, "Repro412C Two");
  await createScratchPage(page, "Repro412C Three");

  await openScratch(page, "repro412-c");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.type("see [[");
  await expect(page.getByTestId("embed-picker-input")).toBeVisible();
  await page.getByTestId("embed-picker-input").fill("Repro412C");
  const items = page.getByTestId("embed-picker-item");
  await expect(items.nth(2)).toBeVisible({ timeout: 10000 });
  // sweep the mouse down the list in many small steps (real hover), ending on item 2
  const b0 = (await items.nth(0).boundingBox())!;
  const b2 = (await items.nth(2).boundingBox())!;
  await page.mouse.move(b0.x + 40, b0.y + 4);
  await page.mouse.move(b0.x + 40, b2.y + b2.height / 2, { steps: 25 });
  await sleep(150);
  await page.mouse.down();
  await sleep(40);
  await page.mouse.up();
  await expect(page.getByTestId("embed-picker-input")).toHaveCount(0, { timeout: 3000 });
  const s = await srcText(page);
  expect(s).toContain("(/p/");
});

// D: the cursor is ALREADY sitting where the list will appear; hits render under the stationary
// cursor; click WITHOUT any pointermove (mouse.down/up at the current position).
test("#412: items appear under a stationary cursor; click with no move at all", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await page.goto("/p/demo");
  await page.waitForSelector("[data-pane=preview] .cm-content");
  await createScratchPage(page, "Repro412D One");
  await createScratchPage(page, "Repro412D Two");

  await openScratch(page, "repro412-d");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.type("see [[");
  await expect(page.getByTestId("embed-picker-input")).toBeVisible();
  // find where the SECOND item will be: type once to learn geometry, park the mouse there,
  // clear, retype, and click without moving.
  await page.getByTestId("embed-picker-input").fill("Repro412D");
  const items = page.getByTestId("embed-picker-item");
  await expect(items.nth(1)).toBeVisible({ timeout: 10000 });
  const b1 = (await items.nth(1).boundingBox())!;
  const px = b1.x + 60, py = b1.y + b1.height / 2;
  await page.mouse.move(px, py);
  await page.getByTestId("embed-picker-input").fill("");
  await sleep(400); // list empties (debounce + refetch)
  await page.getByTestId("embed-picker-input").fill("Repro412D");
  await expect(items.nth(1)).toBeVisible({ timeout: 10000 });
  await sleep(100); // items re-rendered under the stationary cursor; DO NOT move the mouse
  await page.mouse.down();
  await sleep(40);
  await page.mouse.up();
  await expect(page.getByTestId("embed-picker-input")).toHaveCount(0, { timeout: 3000 });
  const s = await srcText(page);
  expect(s).toContain("(/p/");
});
