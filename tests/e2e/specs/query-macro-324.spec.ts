import { test, expect } from "@playwright/test";
import { enterEdit, openScratch, sleep } from "../helpers";

// #324 / ADR-134: the `:::query` in-body dynamic list. Real Chromium (the widget resolves via a host-mediated,
// member-only fetch and swaps its DOM asynchronously — a synthetic env can't exercise fetch → render → measure).

// `backlinks` spec → the pages that link HERE (the member-live view-filtered path, GET /pages/:id/query).
test("#324: :::query backlinks lists the pages that link here and navigates on click", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  const target = await openScratch(page, "qm-target");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("I am the target.\n\n:::query\nbacklinks\n:::\n");
  await sleep(300);
  await page.getByTestId("publish-page").click();
  await sleep(600);

  const linker = await openScratch(page, "qm-linker");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(`see [the target](/p/${target}) here\n`);
  await sleep(300);
  await page.getByTestId("publish-page").click();
  await sleep(800);

  await page.goto(`/p/${target}`);
  await page.waitForSelector("[data-pane=preview] .cm-content");
  await sleep(500);
  const item = page.getByTestId(`macro-query-item-${linker}`);
  await expect(item).toBeVisible({ timeout: 10000 });
  await expect(item).toHaveText("qm-linker");
  await item.click();
  await expect(page).toHaveURL(new RegExp(`/p/${linker}$`));
});

// `tag <pageId>` spec → the pages linking to that tag page (its members) — the tag-as-link model.
test("#324: :::query tag <id> lists the members of that tag page (tag = link)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  // The tag page.
  const tagPage = await openScratch(page, "qm-recipes");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("the recipes tag.\n");
  await sleep(200);
  await page.getByTestId("publish-page").click();
  await sleep(500);

  // A page tagged with it (= a link to the tag page).
  const member = await openScratch(page, "qm-carbonara");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(`tagged [recipes](/p/${tagPage}) here\n`);
  await sleep(200);
  await page.getByTestId("publish-page").click();
  await sleep(800);

  // A hub page whose :::query surfaces the tag page's members.
  await openScratch(page, "qm-hub");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(`hub\n\n:::query\ntag ${tagPage}\n:::\n\nbelow\n`);
  await sleep(400);
  await page.keyboard.press("Control+End"); // caret away → widget renders
  await sleep(500);
  const item = page.getByTestId(`macro-query-item-${member}`);
  await expect(item).toBeVisible({ timeout: 10000 });
  await expect(item).toHaveText("qm-carbonara");
});

// Empty ⇒ nothing (§3): on the EDIT surface a dim placeholder keeps the atom selectable; NO list renders.
test("#324: :::query renders a dim placeholder (no list) when nothing matches", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "qm-lonely");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("nothing matches.\n\n:::query\nbacklinks\n:::\n");
  await sleep(700);
  await expect(page.getByTestId("macro-query-empty")).toBeVisible({ timeout: 10000 });
  expect(await page.getByTestId("macro-query").count()).toBe(0); // no list box
});
