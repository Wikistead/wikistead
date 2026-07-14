import { test, expect } from "@playwright/test";
import { openScratch, createScratchPage, enterEdit, sleep, publishAndWait } from "../helpers";

const vimInsert = (p: import("@playwright/test").Page) => p.evaluate(() => (window as unknown as { __lpVimInsert?: boolean }).__lpVimInsert === true);
const headLine = (p: import("@playwright/test").Page) => p.evaluate(() => (window as unknown as { __lpHeadLine?: number }).__lpHeadLine ?? -1);

// #205 part 2 / ADR-071: the `:::embed-page` title-search picker. The slash command "Embed a page"
// opens a picker whose candidates are FGA-view-filtered (GET /search); selecting one inserts
// `:::embed-page\n<id>\n:::`. Here we exercise the deterministic raw-id path (typing a page id
// directly, the fallback that doesn't depend on Meilisearch indexing timing) → insert → the
// embed-page macro widget renders in place of the raw block.
test("slash 'embed a page' → picker → pick a page id → inserts :::embed-page and renders the widget", async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto("/p/demo");
  await page.waitForSelector("[data-pane=preview] .cm-content");
  const targetId = await createScratchPage(page, "Embed Target Page");

  await openScratch(page, "embed-host");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");

  // Open the slash palette and choose "Embed a page".
  await page.keyboard.type("/embed");
  await expect(page.getByTestId("slash-palette")).toBeVisible();
  await page.click('[data-testid="slash-item-macro:embed-page"]');

  // The picker dialog opens; type the target page id → the raw-id escape hatch appears.
  await expect(page.getByTestId("embed-picker-input")).toBeVisible();
  await page.getByTestId("embed-picker-input").fill(targetId);
  await expect(page.getByTestId("embed-picker-raw")).toBeVisible();
  await page.getByTestId("embed-picker-raw").click();

  // The picker closed and the embed-page block was inserted → its host-mediated widget renders.
  await expect(page.getByTestId("embed-picker-input")).toHaveCount(0);
  await sleep(300);
  await expect(page.locator("[data-pane=preview] [data-testid=macro-embed-page]")).toBeVisible();
});

// #348: the embed picker now has a right-hand rich PREVIEW of the highlighted hit (shared with the search
// modal, view-gated body via the member read-engine), and the widened 2-pane dialog.
test("#348: the embed picker shows a rich preview of the highlighted hit + a space icon", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  const title = `Preview Embed ${Date.now().toString(36)}`;
  await page.goto("/p/demo");
  await page.waitForSelector("[data-pane=preview] .cm-content");
  const targetId = await createScratchPage(page, title);
  // publish a body so the preview has rich content, and let it index so it's a search hit.
  await page.goto(`/p/${targetId}?edit=1`);
  await page.waitForSelector("[data-pane=preview] .cm-content");
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.type("embed preview body 348 with **strong words**");
  await publishAndWait(page, targetId, "embed preview body 348");
  await sleep(1200); // Meili index (outbox drain)

  await openScratch(page, "embed-preview-host");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.type("/embed");
  await expect(page.getByTestId("slash-palette")).toBeVisible();
  await page.click('[data-testid="slash-item-macro:embed-page"]');
  await expect(page.getByTestId("embed-picker-input")).toBeVisible();

  // the dialog is the widened 2-pane size.
  const dialogW = (await page.locator("[data-slot=dialog-content]").boundingBox())!.width;
  expect(dialogW, `embed picker width ${dialogW} should be the wide 2-pane size`).toBeGreaterThan(700);

  // search by title → the hit appears (with a space icon), cmdk auto-highlights the first → the preview renders.
  await page.getByTestId("embed-picker-input").fill(title);
  await expect(page.getByTestId("embed-picker-item").first()).toBeVisible({ timeout: 10000 });
  expect(await page.locator("[data-testid=embed-picker-item] [role=img]").count(), "hit row has a space icon").toBeGreaterThan(0);
  // the right preview pane renders the published body RICHLY via the read-engine (.cm-content) — the bold text
  // shows with its `**` markers HIDDEN (a raw source dump would show the literal `**strong words**`).
  const preview = page.getByTestId("embed-picker-preview");
  await expect(preview.locator(".cm-content")).toBeVisible({ timeout: 10000 });
  await expect(preview.locator(".cm-content")).toContainText("strong words", { timeout: 10000 });
  await expect(preview.locator(".cm-content")).not.toContainText("**strong words**");
});

// #332 (review reject): in vim, the `/embed` picker (run from the INSERT-mode slash palette)
// used to leave the caret STRANDED on a blank line below the card in INSERT mode. A picker-completed
// embed-page is `atomSelectable` (transclude.ts), so after the pick vim drops to NORMAL and the caret
// rests ON the atom: the card renders (never raw) and the caret sits on the block (blank-fatcursor). Raw
// editing is still reachable by Ctrl+Enter (the id is edited via ⇆ / explicit entry, not caret-in). Real
// Chromium + vim (the reveal boundary + vim-mode transition are synthetic-DOM-invisible).
test("#332: vim /embed picker leaves NORMAL mode with the caret on the rendered atom (not insert on a blank line)", async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto("/p/demo");
  await page.waitForSelector("[data-pane=preview] .cm-content");
  const targetId = await createScratchPage(page, "Embed Target 332");

  await openScratch(page, "embed-host-332");
  await enterEdit(page);
  await page.getByTestId("vim-toggle").click();
  await expect(page.getByTestId("vim-toggle")).toHaveAttribute("aria-pressed", "true");
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.press("i"); // INSERT mode — the slash palette is an insert-mode trigger
  await page.keyboard.type("/embed");
  await expect(page.getByTestId("slash-palette")).toBeVisible();
  await page.click('[data-testid="slash-item-macro:embed-page"]');
  await expect(page.getByTestId("embed-picker-input")).toBeVisible();
  await page.getByTestId("embed-picker-input").fill(targetId);
  await page.getByTestId("embed-picker-raw").click();
  await expect(page.getByTestId("embed-picker-input")).toHaveCount(0);
  await sleep(300);

  // The card renders — the block never reveals raw (atomSelectable: an empty caret selects, not reveals).
  await expect(page.locator("[data-pane=preview] [data-testid=macro-embed-page]")).toBeVisible();
  expect(await page.locator("[data-pane=preview] .cm-content").innerText()).not.toContain(":::embed-page");
  // vim is back in NORMAL (not stranded in insert) and the caret rests ON the rendered block atom — its
  // line falls within a live-preview block range (the widget), NOT a blank line below the card.
  expect(await vimInsert(page), "vim dropped back to normal after the pick").toBe(false);
  const onAtom = await page.evaluate(() => {
    const w = window as unknown as { __lpHeadLine?: number; __lpBlocks?: { fromLine: number; toLine: number }[] };
    const h = w.__lpHeadLine ?? -1;
    return { h, onBlock: (w.__lpBlocks ?? []).some((b) => b.fromLine <= h && h <= b.toLine) };
  });
  expect(onAtom.h, "the caret is on the atom's opening line, not a blank line below").toBe(1);
  expect(onAtom.onBlock, "the caret's line is inside a rendered macro block (the card), not a bare line").toBe(true);

  // #332items 1 & 2: the selection reads like the IMAGE atom — the vim fat cursor's GLYPH is BLANKED
  // (no bright raw `:` leaking on the cursor) and the full-card ring is the selection indicator. The blank is
  // applied by the vimWysiwygCaretGuard AND must SURVIVE CM's focus className rebuild (the picker re-pins the
  // caret on a 2nd frame). Assert the editor carries the blank-fatcursor class and the fat cursor glyph is
  // transparent right after the pick (it used to show a coloured `:` until the next keystroke).
  const sel = await page.evaluate(() => {
    const pane = document.querySelector("[data-pane=preview]") as HTMLElement | null;
    const view = pane?.querySelector(".cm-editor") as HTMLElement | null;
    const fat = pane?.querySelector(".cm-fat-cursor") as HTMLElement | null;
    const wrap = pane?.querySelector("[data-testid=macro-embed-page]")?.closest(".cm-lp-macro-wrap") as HTMLElement | null;
    const cs = fat ? getComputedStyle(fat) : null;
    return {
      hideClass: view?.classList.contains("cm-atomsel-hide-fatcursor") ?? false,
      fatGlyphColor: cs ? cs.color : null,
      fatBgColor: cs ? cs.backgroundColor : null,
      ring: wrap?.classList.contains("cm-lp-atom-sel") ?? false,
    };
  });
  // #332the WHOLE fat cursor is suppressed on a selected atomSelectable atom — glyph AND the pink
  // background block — via editorAttributes (survives the focus rebuild, no timing re-pin). The full-card ring
  // is the only selection affordance.only blanked the glyph, so a ~10px pink bar stayed on the card.
  expect(sel.hideClass, "the atomsel-hide-fatcursor class is applied (via editorAttributes, survives the focus rebuild)").toBe(true);
  expect(sel.fatGlyphColor, "the fat cursor glyph is transparent (no raw `:` leaks on the cursor)").toBe("rgba(0, 0, 0, 0)");
  expect(sel.fatBgColor, "the fat cursor pink BACKGROUND block is transparent (not a thin bar on the card)").toBe("rgba(0, 0, 0, 0)");
  expect(sel.ring, "the full-card selection ring is shown (image-atom look)").toBe(true);

  // #332item 3 (user ruling): Ctrl+Enter on the selected atom opens the RETARGET PICKER (the ⇆ UI),
  // NOT the raw reveal — the id is re-picked, never hand-edited in the block. The raw `:::embed-page` must NOT
  // appear; the picker input must.
  await page.keyboard.press("Control+Enter");
  await expect(page.getByTestId("embed-picker-input")).toBeVisible({ timeout: 4000 });
  expect(await page.locator("[data-pane=preview] .cm-content").innerText()).not.toContain(":::embed-page");
  await page.keyboard.press("Escape"); // close the picker without changing the target
  await expect(page.getByTestId("embed-picker-input")).toHaveCount(0);
});

// #332item 4: the picker auto-highlights the FIRST hit so Enter confirms immediately (no arrowing), and
// Ctrl-j/k move the highlight. Real Chromium (the cmdk controlled-value + shouldFilter=false auto-select is a
// runtime behaviour). Uses the deterministic search-by-title path.
test("#332the embed picker auto-selects the first hit (Enter confirms without arrowing)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  const title = `Autoselect Embed ${Date.now().toString(36)}`;
  await page.goto("/p/demo");
  await page.waitForSelector("[data-pane=preview] .cm-content");
  const targetId = await createScratchPage(page, title);
  await page.goto(`/p/${targetId}?edit=1`);
  await page.waitForSelector("[data-pane=preview] .cm-content");
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.type("autoselect body");
  await publishAndWait(page, targetId, "autoselect body");
  await sleep(1200); // Meili index

  await openScratch(page, "embed-autoselect-host");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.type("/embed");
  await expect(page.getByTestId("slash-palette")).toBeVisible();
  await page.click('[data-testid="slash-item-macro:embed-page"]');
  await expect(page.getByTestId("embed-picker-input")).toBeVisible();
  await page.getByTestId("embed-picker-input").fill(title);
  // the first hit appears and is auto-highlighted (aria-selected) → pressing Enter confirms it directly.
  const firstHit = page.getByTestId("embed-picker-item").first();
  await expect(firstHit).toBeVisible({ timeout: 10000 });
  await expect(firstHit).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("embed-picker-input")).toHaveCount(0);
  await sleep(300);
  // the chosen page was embedded (Enter picked the auto-highlighted first hit — not a no-op).
  await expect(page.locator("[data-pane=preview] [data-testid=macro-embed-page]")).toBeVisible();
});

// #366a SINGLE-TOKEN query (no spaces) offers the raw-id fallback row too. Typing used to let that raw
// row STEAL the selection — on the query change hits dropped to [] for a frame, the raw row got auto-selected,
// and it never recovered (it stayed in the list). Now the first REAL hit stays selected; the raw row is only
// auto-selected when there are NO real hits. Real Chromium (the cmdk controlled-value race is runtime-only).
test("#366a single-token query keeps the first REAL hit selected, not the raw-id fallback", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  const token = `embedtok${Date.now().toString(36)}`; // single token → the raw fallback row is offered
  await page.goto("/p/demo");
  await page.waitForSelector("[data-pane=preview] .cm-content");
  const targetId = await createScratchPage(page, token);
  await page.goto(`/p/${targetId}?edit=1`);
  await page.waitForSelector("[data-pane=preview] .cm-content");
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.type("token body here");
  await publishAndWait(page, targetId, "token body here");
  await sleep(1200); // Meili index

  await openScratch(page, "embed-c1775-host");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.type("/embed");
  await expect(page.getByTestId("slash-palette")).toBeVisible();
  await page.click('[data-testid="slash-item-macro:embed-page"]');
  await expect(page.getByTestId("embed-picker-input")).toBeVisible();
  // type the token char-by-char (each keystroke changes the query → the frame that used to steal the selection).
  await page.getByTestId("embed-picker-input").pressSequentially(token, { delay: 40 });

  const firstHit = page.getByTestId("embed-picker-item").first();
  await expect(firstHit).toBeVisible({ timeout: 10000 });
  await sleep(500); // let the query settle (and any raw-steal frame pass)
  // the FIRST REAL hit is selected; the raw-id fallback row (which IS present) is NOT.
  await expect(firstHit).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("embed-picker-raw")).toBeVisible(); // the raw row exists (single token)…
  await expect(page.getByTestId("embed-picker-raw")).toHaveAttribute("aria-selected", "false"); // …but is NOT selected
  // Enter confirms the REAL hit (embeds the page), not the raw id.
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("embed-picker-input")).toHaveCount(0);
  await sleep(300);
  await expect(page.locator("[data-pane=preview] [data-testid=macro-embed-page]")).toBeVisible();
});

// #344: the picker dialog is TOP-PINNED, so its top input never shifts vertically as the candidate list
// grows/shrinks (the "input jumps while typing" bug on center-aligned dialogs with variable content).
test("#344/#366the picker input stays put vertically as the candidate list changes", async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto("/p/demo");
  await page.waitForSelector("[data-pane=preview] .cm-content");
  const targetId = await createScratchPage(page, "Embed Target 344");

  await openScratch(page, "embed-host-344");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.type("/embed");
  await expect(page.getByTestId("slash-palette")).toBeVisible();
  await page.click('[data-testid="slash-item-macro:embed-page"]');

  const input = page.getByTestId("embed-picker-input");
  await expect(input).toBeVisible();
  await sleep(350); // #366let the open zoom animation settle before measuring (else scale artifacts)
  // #366FIXED height + centered (replacing the #344 top-pin). The input still sits in the upper third
  // because the box is a tall (72vh) centered panel; the load-bearing guarantee below is that it does NOT move
  // when the candidate list changes size (the fixed height no longer reflows the box).
  const vh = page.viewportSize()!.height;
  const y0 = (await input.boundingBox())!.y;
  expect(y0, "the input is in the upper third of the tall centered panel").toBeLessThan(vh * 0.35);

  // Grow the candidate list (the raw-id item appears; the empty state disappears) → the input must NOT move.
  await input.fill(targetId);
  await expect(page.getByTestId("embed-picker-raw")).toBeVisible();
  await sleep(150);
  const y1 = (await input.boundingBox())!.y;
  // Fixed-height box → the input doesn't shift when the list grows (a content-sized box would reflow it).
  expect(Math.abs(y1 - y0), "the input does not shift when the list changes size").toBeLessThan(5);
});

// #366the picker modal height is FIXED (centered), so navigating hits — which changes the preview body
// height — no longer stretches/shrinks the modal (the reported jitter), and each pane scrolls on its own.
test("#366the embed picker modal height stays fixed as the query/preview changes; panes scroll independently", async ({ browser }) => {
  const page = await (await browser.newContext({ viewport: { width: 1360, height: 900 } })).newPage();
  await page.goto("/p/demo");
  await page.waitForSelector("[data-pane=preview] .cm-content");
  await openScratch(page, "embed-fixed-height");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.type("/embed");
  await expect(page.getByTestId("slash-palette")).toBeVisible();
  await page.click('[data-testid="slash-item-macro:embed-page"]');
  await expect(page.getByTestId("embed-picker-input")).toBeVisible();
  await sleep(350); // let the open zoom animation settle so height measurements are stable

  const dialog = page.getByRole("dialog").filter({ has: page.getByTestId("embed-picker-input") });
  const h0 = (await dialog.boundingBox())!.height;

  // a query with real hits → the preview pane renders a body (tall); the modal must NOT grow.
  await page.getByTestId("embed-picker-input").fill("demo");
  await sleep(600);
  const h1 = (await dialog.boundingBox())!.height;

  // a long raw-id query → different candidate set / empty preview; the modal must NOT shrink.
  await page.getByTestId("embed-picker-input").fill("some-long-raw-page-id-1234567890abcdef");
  await sleep(400);
  const h2 = (await dialog.boundingBox())!.height;

  expect(Math.abs(h1 - h0), `modal height jittered with hits (${h0}→${h1})`).toBeLessThanOrEqual(1);
  expect(Math.abs(h2 - h0), `modal height jittered on the raw row (${h0}→${h2})`).toBeLessThanOrEqual(1);

  // both panes scroll on their own (overflow-y:auto), so a short/tall preview never resizes the box.
  const previewOverflow = await page.getByTestId("embed-picker-preview").evaluate((el) => getComputedStyle(el).overflowY);
  expect(previewOverflow).toBe("auto");
});
