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
  // rendered surface (caret rests on the trailing line, so this line renders, not raw): the bracketed text
  // stays literal and is NOT a link. #323 a bare `[text]` with no destination must NOT be styled as
  // a link — no `<a>` AND no `.cm-lp-link` (the bug rendered the inner text link-like), and the `[ ]`
  // brackets stay visible (reader parity — a plain <span>, not a collapsed link-looking `not a link`).
  const line = page.locator("[data-pane=preview] .cm-line", { hasText: "not a link" }).first();
  await expect(line).toBeVisible();
  expect(await line.locator("a").count()).toBe(0);
  expect(await line.locator(".cm-lp-link").count(), "a bare [text] must not be link-styled").toBe(0);
  expect(await line.innerText(), "the [[ ]] brackets stay literal (not hidden)").toContain("[[not a link]]");
  // (review bounce): the bug was NOT a decoration — the SYNTAX HIGHLIGHTER tinted the `[not a link]`
  // Link node blue even after. Measure the COMPUTED colour (a `.cm-lp-link` class assert can't catch a
  // highlight-span colour): the bracketed text must be the SAME body colour as a plain word on the line, not the
  // link blue.
  const colours = await line.evaluate((lineEl: Element) => {
    const walker = document.createTreeWalker(lineEl, NodeFilter.SHOW_TEXT);
    let linkEl: Element | null = null, plainEl: Element | null = null, n: Node | null = null;
    while ((n = walker.nextNode())) {
      if (!linkEl && n.textContent?.includes("not")) linkEl = n.parentElement;
      if (!plainEl && n.textContent?.includes("plain")) plainEl = n.parentElement;
    }
    return { link: linkEl ? getComputedStyle(linkEl).color : null, plain: plainEl ? getComputedStyle(plainEl).color : null };
  });
  expect(colours.link, "the bare [text] is body-coloured, not the syntax link blue").toBe(colours.plain);
});

// #323 colour reflects SEMANTICS, not the tokenizer — a bare `[text]` (no destination) is body-coloured
// on EVERY surface: caret-away, caret-IN (revealed), and Source mode. A REAL `[text](url)` keeps its link
// colour on reveal/Source. Measure computed colour (a class assert can't catch a highlight-span colour).
const colourOf = (line: import("@playwright/test").Locator, needle: string) =>
  line.evaluate((el: Element, s: string) => {
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let n: Node | null = null;
    while ((n = w.nextNode())) if (n.textContent?.includes(s)) return getComputedStyle(n.parentElement!).color;
    return null;
  }, needle);

test("#323 a bare [text] is body-coloured on reveal AND in Source; a real link stays link-coloured", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  const targetId = await createScratchPage(page, "Real Target 636");
  await openScratch(page, "pagelink-semantic-colour");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(`plain [[not a link]] and [go](/p/${targetId}) done\n\ntail\n`);
  await sleep(400);

  const bareLine = page.locator("[data-pane=preview] .cm-line", { hasText: "not a link" }).first();

  // (a) caret-IN (reveal): put the caret ON the bracketed line → it renders raw markdown, but a bare [text]
  // must STILL be body-coloured (dropped the old caret-away-only gate).
  await page.getByText("not a link").click();
  await sleep(200);
  expect(await colourOf(bareLine, "not a link"), "bare [text] is body colour while revealed").toBe(await colourOf(bareLine, "plain"));
  // …but the REAL link on the same line keeps its link colour (not over-suppressed).
  expect(await colourOf(bareLine, "go"), "a real [text](url) keeps its link colour on reveal").not.toBe(await colourOf(bareLine, "plain"));

  // (b) Source mode: fully raw — the bare [text] is still body-coloured, the real link still link-coloured.
  await page.getByTestId("displaymode-source").click();
  await sleep(300);
  const srcLine = page.locator("[data-pane=preview] .cm-line", { hasText: "not a link" }).first();
  expect(await colourOf(srcLine, "not a link"), "bare [text] is body colour in Source").toBe(await colourOf(srcLine, "plain"));
  expect(await colourOf(srcLine, "go"), "a real [text](url) keeps its link colour in Source").not.toBe(await colourOf(srcLine, "plain"));
});
