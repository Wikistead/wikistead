import { test, expect } from "@playwright/test";
import { enterEdit, openScratch, sleep } from "../helpers";

// #278D: the mermaid/plantuml editUI source pane must HUG a short source — the host clearance
// (padding-bottom 4.5rem + header-band top) leaked into the nested editor and inflated a 1-line source to
// ~208px. Neutralized for any nested editor (tokens.css). A 1-line source pane should be well under 70px.
test("#278D: the mermaid editUI source pane hugs a 1-line source (<70px)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "mermaid-hug"); await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("top\n```mermaid\nflowchart TD\n```\n\nbelow\n"); // a short (1-content-line) source
  await sleep(700);
  await page.getByText("below", { exact: true }).click(); await sleep(200); // caret out → atom renders
  await page.locator("[data-pane=preview] [data-testid=macro-mermaid]").hover(); await sleep(150);
  await page.locator("[data-pane=preview] [data-testid=macro-edit]").first().click({ force: true });
  await sleep(400);
  const src = page.locator("[data-pane=preview] .cm-lp-mermaid-edit-src");
  await expect(src).toBeVisible();
  const h = await src.evaluate((el) => Math.round(el.getBoundingClientRect().height));
  expect(h, `mermaid source pane must hug the content, not the leaked clearance (was ${h}px)`).toBeLessThan(70);
});

// #278G: a tab is the SAME width with or without its × (the × is absolute now → no flow width), so an
// edit-mode tab and a Reading-mode tab (no ×) match.
test("#278G: tab width is unchanged by the × affordance (edit vs Reading)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "tab-width"); await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("::::tabs\n:::tab[Alpha]\na\n:::\n:::tab[Beta]\nb\n:::\n::::\n\nbot\n");
  await sleep(700);
  await page.getByText("bot", { exact: true }).click(); await sleep(200);
  const tabAlpha = page.locator("[data-pane=preview] .cm-lp-tab", { hasText: "Alpha" }).first();
  const wEdit = await tabAlpha.evaluate((el) => Math.round(el.getBoundingClientRect().width));
  // switch to Reading (no × appended) and re-measure the same tab.
  await page.getByTestId("displaymode-reading").click({ force: true }).catch(() => {});
  await sleep(400);
  const tabAlphaR = page.locator("[data-pane=preview] .cm-lp-tab", { hasText: "Alpha" }).first();
  const wRead = await tabAlphaR.evaluate((el) => Math.round(el.getBoundingClientRect().width));
  expect(Math.abs(wEdit - wRead), `tab width must match edit(${wEdit}) vs reading(${wRead})`).toBeLessThanOrEqual(1);
});

// #278H: an EMPTY column follows the row height (align-items: stretch), so its whole box is clickable
// next to a tall neighbour — not a 1.6em strip.
test("#278H: an empty column follows the row height (clickable full height)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "empty-col"); await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  // left column TALL (several lines), right column EMPTY.
  await page.keyboard.insertText("top\n\n::::columns\n:::column\nL1\n\nL2\n\nL3\n\nL4\n:::\n:::column\n:::\n::::\n\nbot\n");
  await sleep(800);
  await page.getByText("bot", { exact: true }).click(); await sleep(300);
  const cols = page.locator("[data-pane=preview] [data-testid=macro-columns] .cm-lp-column");
  const heights = await cols.evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
  expect(heights.length).toBe(2);
  const [tall, empty] = heights;
  expect(empty, `empty column height ${empty} should follow the tall column ${tall}`).toBeGreaterThan(tall * 0.7);
  // the empty column carries the discoverability class + a hover affordance (outline).
  const emptyCol = page.locator("[data-pane=preview] .cm-lp-column-empty").first();
  await expect(emptyCol).toHaveCount(1);
  await emptyCol.hover(); await sleep(150);
  const outline = await emptyCol.evaluate((el) => getComputedStyle(el).outlineStyle);
  expect(outline, "empty column shows a hover affordance outline").toBe("dashed");
});
