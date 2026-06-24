import { test, expect, type Page } from "@playwright/test";
import { openDemo, openScratch, enterEdit, resetDoc, sleep } from "../helpers";

const content = (p: Page) => p.locator("[data-pane=preview] .cm-content").innerText();

// M0-1 (ADR-017): the slash command palette. `/` at a line start OR after whitespace
// opens a filterable insert/toggle menu in the CM tooltip layer; choosing a command
// removes the typed token, inserts a Markdown template, and places the caret at the
// content position.
test("slash palette: open, filter, Ctrl-j nav, Enter applies with caret at content", async ({ page }) => {
  await openDemo(page);
  await enterEdit(page);
  await resetDoc(page);
  await page.click("[data-pane=preview] .cm-content");

  await page.keyboard.type("/");
  await expect(page.getByTestId("slash-palette")).toBeVisible();
  expect(await page.locator("[data-testid=slash-palette] .lp-palette-row").count()).toBeGreaterThan(3);
  // first item selected; Ctrl-j moves to the next (vim-style; Ctrl-n is browser-reserved)
  await expect(page.getByTestId("slash-item-h1")).toHaveAttribute("data-selected", "true");
  await page.keyboard.press("Control+j");
  await expect(page.getByTestId("slash-item-h2")).toHaveAttribute("data-selected", "true");
  await expect(page.getByTestId("slash-item-h1")).not.toHaveAttribute("data-selected", "true");

  // English alias filters even with the JP label (no IME switch)
  await page.keyboard.type("quote");
  await expect(page.getByTestId("slash-item-quote")).toBeVisible();
  expect(await page.getByTestId("slash-item-h1").count()).toBe(0);

  // Enter applies; the caret lands after "> " so typed text becomes the quote body
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("slash-palette")).toHaveCount(0);
  await page.keyboard.type("hello");
  expect(await content(page)).toContain("> hello");
});

test("slash palette: aliases shown, click applies, Esc dismisses", async ({ page }) => {
  await openDemo(page);
  await enterEdit(page);

  await resetDoc(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.type("/");
  // each row shows a small English alias next to the JP name
  await expect(page.locator("[data-testid=slash-palette] .lp-palette-alias").first()).toBeVisible();

  // clicking a row applies it (code block → a tinted code line; fences are reveal-hidden)
  await page.getByTestId("slash-item-code").click();
  await expect(page.getByTestId("slash-palette")).toHaveCount(0);
  expect(await page.locator("[data-pane=preview] .cm-lp-code-line").count()).toBeGreaterThan(0);

  // Esc dismisses but keeps the typed "/" as text
  await resetDoc(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.type("/");
  await expect(page.getByTestId("slash-palette")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("slash-palette")).toHaveCount(0);
  expect(await content(page)).toContain("/");
});

test("slash palette: fires at line start or after whitespace, not mid-word", async ({ page }) => {
  await openDemo(page);
  await enterEdit(page);

  // mid-word "/" (preceded by a letter) does NOT open — prose like "and/or" is safe
  await resetDoc(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.type("ab/");
  await sleep(150);
  await expect(page.getByTestId("slash-palette")).toHaveCount(0);

  // "/" after whitespace DOES open (line-start is also covered by the tests above)
  await resetDoc(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.type("ab /");
  await expect(page.getByTestId("slash-palette")).toBeVisible();
});

test("divider inserts a thematic break, not a setext heading", async ({ page }) => {
  await openDemo(page);
  await enterEdit(page);
  await resetDoc(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.type("a title");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/divider");
  await page.keyboard.press("Enter");
  await sleep(200);
  // the line above must NOT become a heading (the `---` setext bug), and a rule renders
  expect(await page.locator("[data-pane=preview] .cm-lp-h").count()).toBe(0);
  expect(await page.locator("[data-pane=preview] .cm-lp-hr").count()).toBeGreaterThan(0);
});

test("selection + / opens the decorate palette; a mnemonic applies (ADR-018 #4/#2)", async ({ page }) => {
  // `/` is insert-primary but ALSO offers decoration on a selection (duplication is
  // intentional). With a selection, `/` opens the decorate palette (the `/` is
  // intercepted, not typed, so the selection survives); pressing the mnemonic applies.
  await openDemo(page);
  await enterEdit(page);
  await resetDoc(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.type("hello world");

  // select "hello"
  await page.keyboard.press("Home");
  for (let i = 0; i < 5; i++) await page.keyboard.press("Shift+ArrowRight");

  await page.keyboard.press("/");
  await expect(page.getByTestId("decorate-palette")).toBeVisible();
  await expect(page.getByTestId("slash-palette")).toHaveCount(0);
  expect(await content(page)).toContain("hello world"); // selection preserved, / not typed

  // mnemonic fast-path: "b" → bold (no arrow-nav needed)
  await page.keyboard.press("b");
  await sleep(150);
  await expect(page.getByTestId("decorate-palette")).toHaveCount(0);
  expect(await content(page)).toContain("**hello**");
});

test("the palette stays within the viewport when opened near the bottom", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "palette-vp");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  // fill enough lines that the caret sits near the bottom of the viewport
  for (let i = 0; i < 40; i++) {
    await page.keyboard.type(`line ${i}`);
    await page.keyboard.press("Enter");
  }
  await page.keyboard.type("/");
  const palette = page.getByTestId("slash-palette");
  await expect(palette).toBeVisible();
  const box = await palette.boundingBox();
  const vh = page.viewportSize()!.height;
  // fully on-screen: not clipped at the top, not running off the bottom (CM flips it
  // above the caret near the bottom edge; position:fixed escapes overflow clipping)
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(vh + 1);
});

test("Ctrl-k navigates the palette when open, opens page search when closed", async ({ page }) => {
  await openDemo(page);
  await enterEdit(page);
  await resetDoc(page);
  await page.click("[data-pane=preview] .cm-content");

  // palette CLOSED → Ctrl-k focuses page search (the global shortcut still works)
  await page.keyboard.press("Control+k");
  await expect(page.getByTestId("search-input")).toBeFocused();

  // palette OPEN → Ctrl-k navigates (wraps up from first to last) and does NOT open search
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.type("/");
  await expect(page.getByTestId("slash-item-h1")).toHaveAttribute("data-selected", "true");
  await page.keyboard.press("Control+k");
  await expect(page.getByTestId("slash-item-divider")).toHaveAttribute("data-selected", "true");
  await expect(page.getByTestId("search-input")).not.toBeFocused();
});
