import { test, expect } from "@playwright/test";
import { enterEdit, openScratch, sleep } from "../helpers";

// #90 / #337 (ADR-043, option A): :::details has a real open/close model. Collapsed → a "▸ summary" bar;
// clicking the bar TOGGLES a rendered body open/closed (display-only, NOT raw); editing (raw reveal) is
// reached via the hover ✎ / Ctrl+Enter, and caret-in still reveals the raw source.
test(":::details toggles a rendered body open/closed from the summary bar (display-only, not raw)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "details");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(":::details[More info]\nthe hidden body\n:::\n\nbelow\n");
  await sleep(400);

  // Collapsed: a "▸" summary bar with the label; the body is NOT shown.
  const bar = page.locator("[data-pane=preview] [data-testid=details-summary-bar]");
  await expect(bar).toBeVisible();
  await expect(bar).toContainText("More info");
  await expect(bar).toContainText("▸");
  const content = page.locator("[data-pane=preview] .cm-content");
  expect(await content.innerText()).not.toContain("the hidden body");

  // Click the bar → OPEN: arrow flips to ▾, the body renders (NOT the raw directive source).
  await bar.click();
  await sleep(250);
  await expect(bar).toContainText("▾");
  const opened = await content.innerText();
  expect(opened).toContain("the hidden body");
  expect(opened).not.toContain(":::details"); // rendered body, not raw reveal

  // Click again → CLOSED: body hidden, back to ▸.
  await bar.click();
  await sleep(250);
  await expect(bar).toContainText("▸");
  expect(await content.innerText()).not.toContain("the hidden body");
});

// #337 issue 2 (edit path): the raw source is reached via the hover ✎ edit button, not by the bar click.
test(":::details ✎ edit button reveals the raw source for editing", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "details");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(":::details[More info]\nthe hidden body\n:::\n\nbelow\n");
  await sleep(400);

  const edit = page.locator("[data-pane=preview] [data-testid=details-edit]");
  await edit.dispatchEvent("mousedown"); // hover-shown (opacity); mousedown is the wired trigger
  await sleep(250);
  const revealed = await page.locator("[data-pane=preview] .cm-content").innerText();
  expect(revealed).toContain(":::details[More info]");
  expect(revealed).toContain("the hidden body");
});

// #337 issue 1: an icon-less directive-label (details) must NOT paint the ::before box — with --cb-icon
// unset it degrades to a solid grey square on the revealed open fence. The label text stays.
test(":::details revealed open fence shows no grey ::before square", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "details");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(":::details[More info]\nthe hidden body\n:::\n\nbelow\n");
  await sleep(400);

  // Reveal raw via the ✎ so the open fence gets the cm-lp-details.cm-lp-directive-label class pair.
  await page.locator("[data-pane=preview] [data-testid=details-edit]").dispatchEvent("mousedown");
  await sleep(250);
  const label = page.locator("[data-pane=preview] .cm-lp-details.cm-lp-directive-label").first();
  await expect(label).toBeVisible();
  const beforeDisplay = await label.evaluate((el) => getComputedStyle(el, "::before").display);
  expect(beforeDisplay).toBe("none");
});
