import { test, expect } from "@playwright/test";
import { openScratch, createScratchPage, enterEdit, sleep } from "../helpers";

// #356: `:::query` discoverability. The spec syntax (`backlinks` / `children` / `tag <pageId>`) and raw page ids
// need not be hand-written — named slash entries insert the preset, and "Tag members" rides the view-gated page
// picker (no hand-typed id). No notation change (the generated source is the existing ADR-134 `:::query` spec).
// Real Chromium (slash palette + picker + async macro render are real-browser-only).

test("#356: '/children' preset inserts :::query children and the macro renders", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "q356-children");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.type("intro line\n");
  await page.keyboard.type("/child");
  await expect(page.getByTestId("slash-palette")).toBeVisible();
  await page.click('[data-testid="slash-item-query-children"]');
  await sleep(250);
  // The preset source was inserted (caret on the spec line reveals raw).
  expect(await page.locator("[data-pane=preview] .cm-content").innerText()).toContain(":::query");
  expect(await page.locator("[data-pane=preview] .cm-content").innerText()).toContain("children");
  // Move the caret OFF the macro → it renders (this scratch page has no children → the dim edit-surface placeholder).
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await sleep(300);
  await expect(page.locator("[data-pane=preview] [data-testid=macro-query-placeholder]")).toBeVisible();
  expect(await page.locator("[data-pane=preview] .cm-content").innerText()).not.toContain(":::query");
});

test("#356: '/tag' opens the view-gated page picker → inserts :::query tag <id> (no hand-typed id)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await page.goto("/p/demo");
  await page.waitForSelector("[data-pane=preview] .cm-content");
  const tagPageId = await createScratchPage(page, "Tag Hub 356");

  await openScratch(page, "q356-tag-host");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.type("/tag");
  await expect(page.getByTestId("slash-palette")).toBeVisible();
  await page.click('[data-testid="slash-item-query-tag"]');
  // The SAME page picker as embed-page opens; use the deterministic raw-id escape hatch.
  await expect(page.getByTestId("embed-picker-input")).toBeVisible();
  await page.getByTestId("embed-picker-input").fill(tagPageId);
  await expect(page.getByTestId("embed-picker-raw")).toBeVisible();
  await page.getByTestId("embed-picker-raw").click();
  await expect(page.getByTestId("embed-picker-input")).toHaveCount(0);
  await sleep(250);
  // The `:::query\ntag <id>\n:::` source was inserted with the PICKED id (caret pinned on the atom → raw shown).
  const text = await page.locator("[data-pane=preview] .cm-content").innerText();
  expect(text).toContain(`tag ${tagPageId}`);
});
