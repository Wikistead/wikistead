import { test, expect } from "@playwright/test";
import { openScratch, enterEdit, sleep } from "../helpers";

// M1 focus-delegation SPIKE (#153 / ADR-054) — go/no-go. Does a nested contenteditable "island"
// inside an atomic CM block widget hold focus while typing (CM doesn't reclaim it / reset its
// selection), and does Esc commit the island text via one dispatch? Run in vim OFF and ON.
async function runSpike(page: any, vim: boolean) {
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("before @SPIKE@ after\n");
  await sleep(300);
  if (vim) { await page.getByTestId("vim-toggle").click(); await page.click("[data-pane=preview] .cm-content"); await page.keyboard.press("Escape"); await sleep(100); }

  const island = page.locator("[data-pane=preview] [data-testid=spike-island]");
  await expect(island).toBeVisible();
  await island.click(); // focus the island
  await sleep(100);

  // (1) focus is in the island.
  expect(await page.evaluate(() => document.activeElement?.getAttribute("data-testid"))).toBe("spike-island");

  // type into the island; (1) focus STAYS, (2) CM doesn't reset selection out of the island.
  await page.keyboard.type("HELLO", { delay: 20 });
  await sleep(100);
  const afterType = await page.evaluate(() => ({
    active: document.activeElement?.getAttribute("data-testid"),
    islandText: document.querySelector("[data-testid=spike-island]")?.textContent,
  }));
  expect(afterType.active).toBe("spike-island"); // CM did NOT steal focus
  expect(afterType.islandText).toBe("HELLO");     // typing landed in the island

  // (3) Esc commits via one dispatch → the doc gains the island text after the token.
  await page.keyboard.press("Escape");
  await sleep(200);
  const docText = await page.locator("[data-pane=preview] .cm-content").innerText();
  expect(docText).toContain("HELLO"); // committed to the doc
}

test("M1 spike (vim OFF): island holds focus while typing; Esc commits", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "m1off"); await enterEdit(page);
  await runSpike(page, false);
});

test("M1 spike (vim ON): island holds focus while typing; Esc commits", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "m1on"); await enterEdit(page);
  await runSpike(page, true);
});
