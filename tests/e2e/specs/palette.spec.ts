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

// #290 / ADR-114: /todo inserts a PLAIN GFM task list (standard Markdown, NOT a :::todo directive).
// The rich :::todo form (title + progress ring) is a later PROMOTION; the palette entry is plain source.
test("#290: /todo inserts a plain GFM task item (not a directive) that renders as a checkbox", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "palette-todo");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");

  await page.keyboard.type("/todo");
  await expect(page.getByTestId("slash-item-todo")).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("slash-palette")).toHaveCount(0);
  // caret lands after "- [ ] " so typed text becomes the task label. On the revealed line the "- " renders
  // as a bullet glyph (•) — proof it's a plain LIST item, not a directive — and "[ ] alpha" stays as text.
  await page.keyboard.type("alpha");
  const revealed = await content(page);
  expect(revealed).toContain("[ ] alpha");
  expect(revealed).not.toContain(":::todo"); // plain source, not the rich directive

  // move the caret off the line → the task item renders as a real checkbox (the ADR-019 path)
  await page.keyboard.press("Enter");
  await page.keyboard.type("beta"); // caret now on line 2 → line 1 not revealed
  await sleep(150);
  await expect(page.getByTestId("task-checkbox")).toBeVisible();
  await expect(page.getByTestId("task-checkbox")).not.toBeChecked();
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

test("link dual-behaviour: /link inserts a URL template; a selection link-ifies (M0-5)", async ({ page }) => {
  await openDemo(page);
  await enterEdit(page);
  await resetDoc(page);
  await page.click("[data-pane=preview] .cm-content");

  // NO selection → `/link` inserts "[](url)" with "url" pre-selected (URL insert): typing
  // replaces the url.
  await page.keyboard.type("/link");
  await expect(page.getByTestId("slash-item-link")).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("slash-palette")).toHaveCount(0);
  await page.keyboard.type("https://x");
  expect(await content(page)).toContain("[](https://x)");

  // WITH a selection → link-ify: select text, `/` opens the decorate palette, mnemonic `l`
  // wraps it as a link.
  await resetDoc(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.type("click");
  await page.keyboard.press("Home");
  for (let i = 0; i < 5; i++) await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.press("/");
  await expect(page.getByTestId("decorate-palette")).toBeVisible();
  await page.keyboard.press("l");
  await sleep(150);
  expect(await content(page)).toContain("[click](url)");
});

test("the palette scrolls to keep the selected item visible (Ctrl-j/k follow)", async ({ page }) => {
  await openDemo(page);
  await enterEdit(page);
  await resetDoc(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.type("/"); // full list (incl. image) — capped height can scroll
  const palette = page.getByTestId("slash-palette");
  await expect(palette).toBeVisible();

  // The selected row sits within the palette's scrollport ([scrollTop, scrollTop+
  // clientHeight]) — i.e. it followed the selection into view rather than being scrolled
  // off. Measured in the container's own scroll coordinates (offsetTop), immune to
  // viewport clipping.
  const inScrollport = (el: HTMLElement) => {
    const sel = el.querySelector("[data-selected=true]") as HTMLElement | null;
    if (!sel) return false;
    const top = sel.offsetTop;
    const bottom = top + sel.offsetHeight;
    return top >= el.scrollTop - 2 && bottom <= el.scrollTop + el.clientHeight + 2;
  };

  // wrap UP from the first item to the LAST row — whatever the palette composition puts there
  // (insert-template since #251; asserting a specific id went stale every time a tail command was
  // added). It can start below the fold.
  await page.keyboard.press("Control+k");
  await expect(palette.locator(".lp-palette-row").last()).toHaveAttribute("data-selected", "true");
  await sleep(80); // let the rAF scroll adjustment run
  expect(await palette.evaluate(inScrollport)).toBe(true);

  // wrap back DOWN to the first item — it must scroll back into view too
  await page.keyboard.press("Control+j");
  await expect(page.getByTestId("slash-item-h1")).toHaveAttribute("data-selected", "true");
  await sleep(80);
  expect(await palette.evaluate(inScrollport)).toBe(true);
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
  // Wait for CM to finalize the tooltip position — it parks tooltips off-screen at
  // y≈-10000 while measuring, so reading boundingBox too early gives a false negative.
  await expect.poll(async () => (await palette.boundingBox())?.y ?? -1e9).toBeGreaterThan(-1000);
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

  // palette CLOSED → Ctrl-k opens the search MODAL with its input focused (#285; the global
  // shortcut still works). Close it again before returning to the editor — the dialog overlay
  // would otherwise intercept the click below.
  await page.keyboard.press("Control+k");
  await expect(page.getByTestId("search-input")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("search-input")).toHaveCount(0);

  // palette OPEN → Ctrl-k navigates (wraps up from first to last) and does NOT open search.
  // Wrap-up lands on the LAST row, whatever the composition puts there (insert-template since #251).
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.type("/");
  await expect(page.getByTestId("slash-item-h1")).toHaveAttribute("data-selected", "true");
  await page.keyboard.press("Control+k");
  const palette = page.getByTestId("slash-palette");
  await expect(palette.locator(".lp-palette-row").last()).toHaveAttribute("data-selected", "true");
  await expect(page.getByTestId("slash-item-h1")).not.toHaveAttribute("data-selected", "true");
  // #285: search is a modal — its input only exists while open, so "did not open" = count 0.
  await expect(page.getByTestId("search-input")).toHaveCount(0);
});

// Light-2: the palette learns recently-used commands and floats them to the top. A fresh
// context starts with empty recency (so the existing tests keep the default order).
test("insert palette surfaces recently-used commands first (Light-2)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "recency-insert");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");

  // default order: h1 is first
  await page.keyboard.type("/");
  await expect(page.getByTestId("slash-item-h1")).toHaveAttribute("data-selected", "true");

  // use "quote" (filter → Enter) → recorded as most-recent
  await page.keyboard.type("quote");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("slash-palette")).toHaveCount(0);

  // reopen on a fresh line → quote now floats to the top (selected by default)
  await page.keyboard.press("Enter");
  await page.keyboard.type("/");
  await expect(page.getByTestId("slash-item-quote")).toHaveAttribute("data-selected", "true");
});

test("decorate palette surfaces recently-used formats first (Light-2)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "recency-decorate");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.type("hello");

  // select "hello", open the decorate palette via `/`; default first item is bold
  await page.keyboard.press("Home");
  for (let i = 0; i < 5; i++) await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.press("/");
  await expect(page.getByTestId("decorate-palette")).toBeVisible();
  await expect(page.getByTestId("decorate-item-bold")).toHaveAttribute("data-selected", "true");

  // apply strike (mnemonic) → recorded as most-recent
  await page.keyboard.press("s");
  await sleep(150);
  expect(await content(page)).toContain("~~hello~~");

  // re-select and reopen → strike now floats to the top (selected by default)
  await page.keyboard.press("Home");
  for (let i = 0; i < 9; i++) await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.press("/");
  await expect(page.getByTestId("decorate-palette")).toBeVisible();
  await expect(page.getByTestId("decorate-item-strike")).toHaveAttribute("data-selected", "true");
});
