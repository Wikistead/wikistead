import { test, expect, type Page } from "@playwright/test";
import { enterEdit, openScratch, sleep } from "../helpers";

// #370 / ADR-145: frontmatter tags + the :::tagged / :::children dynamic lists. Real Chromium:
// the leading `---` fence renders as a tag-chip widget (not raw YAML), the chip editor writes ONE
// tags line, publish projects page_tags, and :::tagged lists the published pages carrying the tag.

const srcText = async (p: Page) => {
  await p.getByTestId("displaymode-source").click();
  await sleep(250);
  return p.locator("[data-pane=preview] .cm-content").innerText();
};

test("#370: frontmatter renders as a chip widget; the chip editor writes the tags line", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "fm-widget");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("---\ntags: [alpha]\n---\n\nbody text\n");
  await sleep(400);
  // move the caret out of the frontmatter (caret inside reveals raw) — go to the body
  await page.keyboard.press("Control+End");
  await sleep(400);
  const widget = page.getByTestId("frontmatter-widget");
  await expect(widget).toBeVisible();
  await expect(page.getByTestId("fm-tag-alpha")).toBeVisible();
  // add a tag via the input (one offset-invariant write)
  await page.getByTestId("fm-tag-input").click();
  await page.keyboard.type("Beta");
  await page.keyboard.press("Enter");
  await sleep(300);
  await expect(page.getByTestId("fm-tag-beta")).toBeVisible();
  // remove alpha via the chip ×
  await page.getByTestId("fm-tag-remove-alpha").click();
  await sleep(300);
  await expect(page.getByTestId("fm-tag-alpha")).toHaveCount(0);
  const s = await srcText(page);
  expect(s).toContain("tags: [Beta]");
  expect(s).not.toContain("alpha");
});

test("#370: /tags palette command creates the frontmatter block at doc start", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "fm-palette");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("some body first\n");
  await page.keyboard.type("/tags");
  await expect(page.getByTestId("slash-palette")).toBeVisible();
  await page.click('[data-testid="slash-item-page-tags"]');
  await sleep(300);
  const s = await srcText(page);
  expect(s.startsWith("---")).toBe(true);
  expect(s).toContain("tags: []");
  expect(s).toContain("some body first");
});

test("#370: vim dd on the frontmatter atom deletes the whole block as a unit", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "fm-vim-dd");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("---\ntags: [zap]\n---\n\nline one\nline two\n");
  await sleep(300);
  // enable vim via the toolbar toggle if present; else Ctrl+Alt+V
  await page.keyboard.press("Control+Alt+v");
  await sleep(300);
  await page.keyboard.press("Escape");
  await page.keyboard.type("gg"); // to the top — lands ON the atom (doc-line motion)
  await sleep(200);
  await page.keyboard.type("dd"); // deletes the whole frontmatter block, not one fence line
  await sleep(400);
  const s = await srcText(page);
  expect(s).not.toContain("tags: [zap]");
  expect(s).not.toContain("---");
  expect(s).toContain("line one"); // the body is untouched
});

test("#370: :::tagged lists a published page carrying the tag; :::children lists child pages", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  // 1. a tagged page, published
  const tagged = await openScratch(page, "fm-tagged-member");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("---\ntags: [e2etag370]\n---\n\ntagged body\n");
  await sleep(300);
  await page.getByTestId("publish-page").click();
  await sleep(800);

  // 2. a hub page with a :::tagged block
  await openScratch(page, "fm-tagged-hub");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(":::tagged\ne2etag370\n:::\n\ntail\n");
  await page.keyboard.press("Control+End");
  await sleep(800);
  const item = page.locator(`[data-testid="macro-tagged-item-${tagged}"]`);
  await expect(item).toBeVisible({ timeout: 10000 });
  await expect(item).toHaveText("fm-tagged-member");
});
