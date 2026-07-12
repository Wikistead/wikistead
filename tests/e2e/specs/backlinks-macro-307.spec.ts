import { test, expect } from "@playwright/test";
import { enterEdit, openScratch, sleep } from "../helpers";

// #307 / ADR-127: the `:::backlinks` in-body macro. Real Chromium (the widget resolves via a host-mediated
// fetch and swaps its DOM asynchronously — a synthetic env can't exercise the fetch → render → measure path).
test("#307: :::backlinks lists the pages that link here and navigates on click", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  // Target page carries a `:::backlinks` block in its own body.
  const target = await openScratch(page, "blm-target");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("I am the target.\n\n:::backlinks\n\n:::\n");
  await sleep(300);
  await page.getByTestId("publish-page").click();
  await sleep(600);

  // A second page links to the target via /p/<id>.
  const linker = await openScratch(page, "blm-linker");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(`see [the target](/p/${target}) here\n`);
  await sleep(300);
  await page.getByTestId("publish-page").click();
  await sleep(800);

  // Re-open the target: the `:::backlinks` widget resolves and lists the linker.
  await page.goto(`/p/${target}`);
  await page.waitForSelector("[data-pane=preview] .cm-content");
  await sleep(500);
  const item = page.getByTestId(`macro-backlink-${linker}`);
  await expect(item).toBeVisible({ timeout: 10000 });
  await expect(item).toHaveText("blm-linker");
  await item.click();
  await expect(page).toHaveURL(new RegExp(`/p/${linker}$`));
});

// Empty ⇒ nothing (§3): on the EDIT surface a dim placeholder keeps the atom selectable; NO list renders.
test("#307: :::backlinks renders a dim placeholder (no list) when there are no backlinks", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  const lonely = await openScratch(page, "blm-lonely");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("nobody links to me.\n\n:::backlinks\n\n:::\n");
  await sleep(700);
  await expect(page.getByTestId("macro-backlinks-empty")).toBeVisible({ timeout: 10000 });
  expect(await page.getByTestId("macro-backlinks").count()).toBe(0); // no list box
});
