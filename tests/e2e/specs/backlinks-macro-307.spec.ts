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

// #307 / a page id in the BODY aggregates THAT page's backlinks (hub use), same convention as
// :::embed-page. Real Chromium.
test("#307 :::backlinks with a page id in its body shows THAT page's backlinks", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  const target = await openScratch(page, "blm-body-A");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("I am A.\n");
  await sleep(200);
  await page.getByTestId("publish-page").click();
  await sleep(500);

  const linker = await openScratch(page, "blm-body-C");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(`see [A](/p/${target}) here\n`);
  await sleep(200);
  await page.getByTestId("publish-page").click();
  await sleep(800);

  // Hub B: a :::backlinks whose BODY is A's id → resolves A's backlinks (C), not B's own.
  await openScratch(page, "blm-hub");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(`hub\n\n:::backlinks\n${target}\n:::\n\nbelow\n`);
  await sleep(400);
  await page.keyboard.press("Control+End"); // caret away → widget renders
  await sleep(500);
  const item = page.getByTestId(`macro-backlink-${linker}`);
  await expect(item).toBeVisible({ timeout: 10000 });
  await expect(item).toHaveText("blm-body-C");
});

// #307 /.4: a non-existent / non-viewable target id renders NOTHING (the endpoint 404s → the widget
// shows nothing), so a page can't be probed. Multi-line / garbage body is likewise treated as 0 results.
test("#307 :::backlinks with a bad/non-existent target renders nothing (existence-hiding)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "blm-hub-bad");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(":::backlinks\nno-such-page-id-xyz\n:::\n\nbelow\n");
  await sleep(400);
  await page.keyboard.press("Control+End");
  await sleep(600);
  await expect(page.getByTestId("macro-backlinks-empty")).toBeVisible({ timeout: 8000 }); // edit surface placeholder
  expect(await page.getByTestId("macro-backlinks").count()).toBe(0); // no list leaked
});
