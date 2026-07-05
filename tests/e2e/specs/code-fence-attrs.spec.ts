import { test, expect } from "@playwright/test";
import { enterEdit, openScratch, sleep } from "../helpers";

// #198 (comment 693 bounce): a code fence with ADR-094 attributes must show ONLY the header
// band (title + lang) + code body in Live — the raw info string
// (`ts title="app.ts" showLineNumbers {1,3}`) must NOT stay visible on the opening line
// (it duplicated the header). It reveals on the caret (like the ::: fence) and is raw in
// Source (round-trip). A plain ```lang fence is untouched. Verified in a real browser.
const FENCE = 'top\n```ts title="app.ts" showLineNumbers {1,3}\nconst a = 1\nconst b = 2\nconst c = 3\n```\nbot\n';
const content = (page: any) => page.locator("[data-pane=preview] .cm-content");

test("#198: attributed fence hides its raw info in Live, reveals on caret + Source", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "fence-attrs");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(FENCE);
  await sleep(500);

  // the header band renders the title + language
  await expect(page.locator(".cm-lp-code-header .cm-lp-code-title")).toHaveText("app.ts");
  await expect(page.locator(".cm-lp-code-header .cm-lp-code-lang")).toHaveText("ts");

  // Live: the RAW info string is hidden — no duplicated `title="app.ts"` / showLineNumbers / {1,3}
  const live = await content(page).innerText();
  expect(live).not.toContain('title="app.ts"');
  expect(live).not.toContain("showLineNumbers");
  expect(live).not.toContain("{1,3}");
  expect(live).toContain("const a = 1"); // the code body is shown

  // caret on the opening fence line reveals the raw info (reveal-on-cursor)
  await page.keyboard.press("Control+Home"); // line 1 "top"
  await page.keyboard.press("ArrowDown");    // line 2 = the opening fence
  await sleep(200);
  const revealed = await content(page).innerText();
  expect(revealed).toContain('title="app.ts"');

  // Source mode: RAW ONLY — raw info round-trips AND the header band / highlight are gone (#198 bounce 3).
  await page.getByTestId("displaymode-source").click();
  await sleep(200);
  const src = await content(page).innerText();
  expect(src).toContain('title="app.ts"');
  expect(src).toContain("showLineNumbers");
  expect(await page.locator(".cm-lp-code-header").count()).toBe(0); // no header band in Source
  expect(await page.locator("[data-pane=preview] .cm-lp-code-hl").count()).toBe(0); // no highlight in Source
});

test("#198 bounce: no blank line between the header band and the code body (Live)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "fence-noblank");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText('top\n```ts title="app.ts"\nconst a = 1\n```\nbot\n');
  await sleep(500);
  // The header band sits DIRECTLY above the first code line — their vertical gap is ~0 (no residual
  // blank opening-fence line). Measure the gap between the header's bottom and the code line's top.
  const gap = await page.evaluate(() => {
    const header = document.querySelector(".cm-lp-code-header") as HTMLElement;
    const codeLine = [...document.querySelectorAll("[data-pane=preview] .cm-line")].find((l) => l.textContent?.includes("const a = 1")) as HTMLElement;
    if (!header || !codeLine) return -1;
    return Math.round(codeLine.getBoundingClientRect().top - header.getBoundingClientRect().bottom);
  });
  expect(gap).toBeGreaterThanOrEqual(0);
  expect(gap).toBeLessThan(12); // less than a full blank text line (~line-height); no residual blank line
});

// #198 comment 770 (1/2): the header (lang tab + copy button) is UNIVERSAL — a plain ```lang fence gets
// it too, not only an attributed one. The copy button must not depend on a filename being present.
test("#198 comment 770: a plain lang fence still gets the tab + copy button", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "fence-plain");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("top\n```ts\nconst a = 1\n```\nbot\n");
  await sleep(500);
  await page.getByText("bot").click(); // caret off the fence so the header renders (not raw-revealed)
  await sleep(200);
  expect(await page.locator(".cm-lp-code-header").count()).toBe(1); // header renders for a plain lang fence
  await expect(page.locator(".cm-lp-code-tab .cm-lp-code-lang")).toHaveText("ts"); // lang badge in the tab
  expect(await page.locator(".cm-lp-code-copy").count()).toBe(1); // copy button present even without a title
});

// #198 (comment 724): B tab-style header + a copy button on the code area's top-right in view modes.
test("#198: filename tab + copy button (view mode) copies the code body; hidden in Source", async ({ browser }) => {
  const ctx = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  const page = await ctx.newPage();
  await openScratch(page, "fence-copy");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText('top\n```ts title="app.ts"\nconst a = 1\nconst b = 2\n```\nbot\n');
  await sleep(500);
  await page.getByText("bot").click(); // caret off the fence so the header renders (not raw-revealed)
  await sleep(200);

  // the tab carries the filename + lang
  await expect(page.locator(".cm-lp-code-tab .cm-lp-code-title")).toHaveText("app.ts");
  // a copy button is present in the (Live) view mode
  const copy = page.locator(".cm-lp-code-copy");
  await expect(copy).toHaveCount(1);

  // clicking it copies the CODE BODY only (no info line, no header)
  await copy.click();
  await sleep(200);
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toBe("const a = 1\nconst b = 2");
  await expect(copy).toHaveClass(/cm-lp-code-copied/); // transient ✓ feedback

  // Source mode: no copy button (raw text is directly selectable)
  await page.getByTestId("displaymode-source").click();
  await sleep(200);
  expect(await page.locator(".cm-lp-code-copy").count()).toBe(0);
});

// #198 comment 752/770: (1) a plain fence and an attributed fence share the SAME base card (background +
// rounded corners); attributes only LAYER a tab / line numbers / highlight on top. comment 770 (3): the
// card ALWAYS keeps its rounded top-left — the tab OVERLAPS to connect (a chip on top) rather than the
// first line flattening — so the code area to the right of the (narrow) tab keeps its rounding. (2) Source
// mode is fully raw — no code-block decoration at all. Verified in a real browser.
test("#198 comment 770: plain & attributed fences share one rounded card base; Source is fully raw", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "codefence-unify");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText('```c\nint x = 1;\nint y = 2;\n```\n\n```ts title="app.ts" showLineNumbers {1}\nconst a = 1\nconst b = 2\n```\n\ntail\n');
  await sleep(400);
  await page.getByText("tail").click(); // caret off the fences
  await sleep(300);

  const m = () => page.evaluate(() => {
    const q = (s: string) => Array.from(document.querySelectorAll(s));
    const firsts = q(".cm-lp-code-first") as HTMLElement[];
    const tabOverlap = q(".cm-lp-code-tab").map((t) => getComputedStyle(t as HTMLElement).marginBottom);
    return {
      codeLines: q(".cm-lp-code-line").length,
      firsts: firsts.length,
      lasts: q(".cm-lp-code-last").length,
      tabbed: q(".cm-lp-code-tabbed").length, // the old flatten class is gone
      tabs: q(".cm-lp-code-tab").length,
      topLefts: firsts.map((e) => getComputedStyle(e).borderTopLeftRadius),
      tabOverlap,
    };
  });

  // Live: BOTH fences are carded (2 firsts / 2 lasts / all base cm-lp-code-line) and BOTH keep a rounded
  // top-left (no flattening) — the tab overlaps the card to connect. Both fences carry a tab (unified).
  const live = await m();
  expect(live.firsts).toBe(2);
  expect(live.lasts).toBe(2);
  expect(live.codeLines).toBe(4);
  expect(live.tabbed).toBe(0); // the flatten class was removed (card stays rounded)
  expect(live.tabs).toBe(2); // every lang fence has a tab
  expect(live.topLefts.every((r) => r !== "0px")).toBe(true); // BOTH cards keep a rounded top-left
  expect(live.tabOverlap.every((mb) => mb !== "0px")).toBe(true); // tabs overlap the card to connect

  // Source: fully raw — no code-block decoration whatsoever.
  await page.getByTestId("displaymode-source").click();
  await sleep(300);
  const src = await m();
  expect(src.codeLines).toBe(0);
  expect(src.firsts).toBe(0);
  expect(await page.locator(".cm-lp-code-tab").count()).toBe(0);
  expect(await page.locator(".cm-lp-code-hl").count()).toBe(0);
});
