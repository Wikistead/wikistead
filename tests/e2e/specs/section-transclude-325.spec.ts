import { test, expect } from "@playwright/test";
import { enterEdit, openScratch, sleep } from "../helpers";

// #325 / ADR-137 slice 1: `:::embed-page` with a `pageId#slug` fragment transcludes ONE section (the heading
// through the next same-or-higher heading), read-only. Real Chromium (the widget resolves via the host-mediated
// view-gated endpoint and swaps its DOM asynchronously — a synthetic env can't exercise fetch → render).

test("#325: :::embed-page with #slug transcludes just that section, not the whole page", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  // Source page with two top-level sections.
  const src = await openScratch(page, "sx-src");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("# Alpha\n\nalpha body here\n\n# Beta\n\nbeta body here\n");
  await sleep(300);
  await page.getByTestId("publish-page").click();
  await sleep(700);

  // Host page transcludes ONLY the Beta section via the slug fragment.
  await openScratch(page, "sx-host");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(`host\n\n:::embed-page\n${src}#beta\n:::\n\nbelow\n`);
  await sleep(400);
  await page.keyboard.press("Control+End"); // caret away → the atom widget renders
  await sleep(600);

  // The transcluded fragment shows Beta (heading + body) but NOT Alpha's body.
  const host = page.locator("[data-pane=preview] .cm-content");
  await expect(host).toContainText("Beta", { timeout: 10000 });
  await expect(host).toContainText("beta body here");
  await expect(host).not.toContainText("alpha body here");
});

// An unknown slug is byte-identical to a denied page: the existence-hiding placeholder, never a distinct error.
test("#325: :::embed-page with an unknown #slug renders the denied placeholder (no section oracle)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  const src = await openScratch(page, "sx-src2");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("# Only Section\n\nbody\n");
  await sleep(300);
  await page.getByTestId("publish-page").click();
  await sleep(700);

  await openScratch(page, "sx-host2");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(`host\n\n:::embed-page\n${src}#no-such-section\n:::\n\nbelow\n`);
  await sleep(400);
  await page.keyboard.press("Control+End");
  await sleep(600);
  await expect(page.getByTestId("macro-embed-page-denied")).toBeVisible({ timeout: 10000 });
});

// #325 slice 2: a block-reference `^id` marker is hidden in the live display (revealed on the caret line), and
// `:::embed-page pageId#^id` transcludes just that block.
test("#325 slice 2: :::embed-page with #^id transcludes just that block; the ^id marker is hidden", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  const src = await openScratch(page, "sx-block-src");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("# Alpha\n\nalpha para\n\ntarget block body ^myblk\n\nmore text\n");
  await sleep(300);
  await page.keyboard.press("Control+End"); // caret OFF the marker line → the ` ^myblk` marker hides
  await sleep(300);
  // the marker is hidden in the rendered text (the block still reads cleanly).
  const host0 = page.locator("[data-pane=preview] .cm-content");
  await expect(host0).toContainText("target block body");
  await expect(host0).not.toContainText("^myblk");
  await page.getByTestId("publish-page").click();
  await sleep(700);

  // Host page transcludes ONLY that block via #^id.
  await openScratch(page, "sx-block-host");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(`host\n\n:::embed-page\n${src}#^myblk\n:::\n\nbelow\n`);
  await sleep(400);
  await page.keyboard.press("Control+End");
  await sleep(600);
  const host = page.locator("[data-pane=preview] .cm-content");
  await expect(host).toContainText("target block body", { timeout: 10000 });
  await expect(host).not.toContainText("alpha para"); // only the one block, not the whole page
  await expect(host).not.toContainText("^myblk"); // the marker is stripped from the transcluded block
});

// #325 slice 2b: "Copy block reference" — right-click a text block → the menu appends a ` ^id` marker (if absent)
// and copies `pageId#^id`; that ref transcludes exactly that block on another page. Real Chromium (clipboard +
// context menu + async transclude fetch are all real-browser-only).
test("#325 slice 2b: Copy block reference appends ^id + clipboards pageId#^id; the ref transcludes the block", async ({ browser }) => {
  const ctx = await browser.newContext();
  await ctx.grantPermissions(["clipboard-read", "clipboard-write"]);
  const page = await ctx.newPage();
  const src = await openScratch(page, "sx-copyref-src");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("first para\n\ncopy this block\n\nlast para\n");
  await sleep(300);
  // Right-click ON the middle paragraph (position the caret there first so the click lands on its line).
  await page.getByText("copy this block", { exact: false }).click();
  await sleep(150);
  await page.getByText("copy this block", { exact: false }).click({ button: "right" });
  await expect(page.getByTestId("context-menu")).toBeVisible();
  await expect(page.getByTestId("ctx-item-copyblockref")).toBeVisible();
  await page.getByTestId("ctx-item-copyblockref").click();
  await sleep(250);
  // The clipboard holds `<src>#^<id>`; the marker was appended to the block's line.
  const ref = await page.evaluate(() => navigator.clipboard.readText());
  expect(ref).toMatch(new RegExp(`^${src}#\\^[a-z0-9-]{3,24}$`));
  // Publish the source so the appended ` ^id` marker is in published_md (transclusion reads the published body).
  await page.getByTestId("publish-page").click();
  await sleep(700);

  // Transclude via the copied ref on a host page → just that block, not the neighbours.
  await openScratch(page, "sx-copyref-host");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(`host top\n\n:::embed-page\n${ref}\n:::\n\nhost bottom\n`);
  await sleep(400);
  await page.keyboard.press("Control+End");
  await sleep(600);
  const host = page.locator("[data-pane=preview] .cm-content");
  await expect(host).toContainText("copy this block", { timeout: 10000 });
  await expect(host).not.toContainText("first para");
  await expect(host).not.toContainText("last para");
});

// #325(review bounce): the transcluded content (and the denied placeholder) sat 6px LEFT of
// ordinary paragraphs — the embed container lacked the `.cm-line` 6px left padding. Pin the GLYPH left of the
// embed body against a normal paragraph's glyph left at a narrow viewport (where the 6px was most visible).
// Real Chromium — a layout geometry assert (no happy-dom layout engine). Measures the true text glyph x via a
// Range, not the box left (the box and the glyph differ by exactly the padding under test).
test("#325transcluded content aligns with normal body text (no 6px left drift)", async ({ browser }) => {
  // 820px: a narrow-but-still-DESKTOP viewport (the chrome collapses to the mobile ⋯ below 768). The 6px
  // drift is absolute (a fixed padding, not proportional), so it is detectable at any width.
  const page = await (await browser.newContext({ viewport: { width: 820, height: 800 } })).newPage();
  const src = await openScratch(page, "sx-align-src");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("# Section\n\nembedded body text\n");
  await sleep(300);
  await page.getByTestId("publish-page").click();
  await sleep(700);

  await openScratch(page, "sx-align-host");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(`normal paragraph line\n\n:::embed-page\n${src}\n:::\n\n`);
  await sleep(400);
  await page.keyboard.press("Control+End");
  await sleep(700);

  // Glyph-left of the first text node whose content includes `needle`, via a Range (true painted x).
  const glyphLeft = (needle: string) => page.evaluate((needle) => {
    const walk = document.createTreeWalker(document.querySelector("[data-pane=preview] .cm-content")!, NodeFilter.SHOW_TEXT);
    let n: Node | null;
    while ((n = walk.nextNode())) {
      if ((n.textContent ?? "").includes(needle)) {
        const r = document.createRange();
        r.selectNodeContents(n);
        return r.getBoundingClientRect().left;
      }
    }
    return -1;
  }, needle);

  const normalX = await glyphLeft("normal paragraph line");
  const embedX = await glyphLeft("embedded body text");
  expect(normalX).toBeGreaterThan(0);
  expect(embedX).toBeGreaterThan(0);
  // After the fix the embed body's glyph left matches the normal paragraph's (was ~6px left before).
  expect(Math.abs(embedX - normalX), `embed glyph left ${embedX} should match normal ${normalX} (±1px)`).toBeLessThanOrEqual(1);
});
