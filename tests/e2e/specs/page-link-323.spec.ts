import { test, expect, type Page } from "@playwright/test";
import { openScratch, createScratchPage, enterEdit, sleep } from "../helpers";

// #323: page-link input completion. Typing `[[` opens the SAME authz-gated page picker the embed-page
// command uses; picking inserts a STANDARD Markdown link `[title](/p/<id>)` — the `[[` trigger text is
// consumed and `[[...]]` is never saved as syntax (Open formats). Escape/cancel leaves the typed `[[`
// untouched. A `/` palette item ("Page link") reaches the same flow.

const srcText = async (p: Page) => {
  await p.getByTestId("displaymode-source").click();
  await sleep(250);
  return p.locator("[data-pane=preview] .cm-content").innerText();
};

test("#323: typing [[ opens the picker; raw-id pick inserts [id](/p/id) and consumes the [[", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await page.goto("/p/demo");
  await page.waitForSelector("[data-pane=preview] .cm-content");
  const targetId = await createScratchPage(page, "Link Target 323");

  await openScratch(page, "pagelink-trigger");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.type("see [[");
  await expect(page.getByTestId("embed-picker-input")).toBeVisible();
  await page.getByTestId("embed-picker-input").fill(targetId);
  await expect(page.getByTestId("embed-picker-raw")).toBeVisible();
  await page.getByTestId("embed-picker-raw").click();
  await expect(page.getByTestId("embed-picker-input")).toHaveCount(0);
  await sleep(300);

  const s = await srcText(page);
  expect(s).toContain(`see [${targetId}](/p/${targetId})`); // raw-id fallback: the id doubles as the text
  expect(s).not.toContain("[["); // the trigger text was consumed
});

test("#323: Escape cancels the picker and the typed [[ stays as plain text (nothing lost, no link syntax)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "pagelink-cancel");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.type("keep [[");
  await expect(page.getByTestId("embed-picker-input")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("embed-picker-input")).toHaveCount(0);
  await sleep(200);
  const s = await srcText(page);
  expect(s).toContain("keep [[");
});

test("#323: the / palette 'Page link' item reaches the same picker and inserts the standard link", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await page.goto("/p/demo");
  await page.waitForSelector("[data-pane=preview] .cm-content");
  const targetId = await createScratchPage(page, "Palette Link Target 323");

  await openScratch(page, "pagelink-palette");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.type("/page");
  await expect(page.getByTestId("slash-palette")).toBeVisible();
  await page.click('[data-testid="slash-item-page-link"]');
  await expect(page.getByTestId("embed-picker-input")).toBeVisible();
  await page.getByTestId("embed-picker-input").fill(targetId);
  await expect(page.getByTestId("embed-picker-raw")).toBeVisible();
  await page.getByTestId("embed-picker-raw").click();
  await sleep(300);
  const s = await srcText(page);
  expect(s).toContain(`[${targetId}](/p/${targetId})`);
  expect(s).not.toContain("/page"); // the palette token was consumed
});

test("#323: picking a TITLE hit inserts [title](/p/id) with markdown-escaped title", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await page.goto("/p/demo");
  await page.waitForSelector("[data-pane=preview] .cm-content");
  // `]` in the title must be escaped in the link text (escLinkText round-trip).
  const title = "Weird ] Title 323";
  const targetId = await createScratchPage(page, title);

  await openScratch(page, "pagelink-title");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.type("[[");
  await expect(page.getByTestId("embed-picker-input")).toBeVisible();
  await page.getByTestId("embed-picker-input").fill("Weird ] Title");
  // search indexing is async (outbox) — poll until the hit appears, then pick it.
  const item = page.getByTestId("embed-picker-item").filter({ hasText: "Weird ] Title 323" }).first();
  await expect(item).toBeVisible({ timeout: 15000 });
  await item.click();
  await sleep(300);
  const s = await srcText(page);
  expect(s).toContain(`[Weird \\] Title 323](/p/${targetId})`);
  expect(s).not.toContain("[[");
});

test("#323: [[...]] is NOT a syntax — inserted (pasted) text renders as plain text, no link", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "pagelink-not-syntax");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  // insertText = a paste-like input (NOT input.type) — the trigger must not fire either.
  await page.keyboard.insertText("plain [[not a link]] text\n");
  await sleep(400);
  await expect(page.getByTestId("embed-picker-input")).toHaveCount(0);
  // rendered surface: the bracketed text stays visible as-is and produces NO anchor.
  const line = page.locator("[data-pane=preview] .cm-line", { hasText: "not a link" }).first();
  await expect(line).toBeVisible();
  expect(await line.locator("a").count()).toBe(0);
});
