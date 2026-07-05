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

test("#198: a PLAIN fence (no attributes) is untouched (no header band)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "fence-plain");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("top\n```ts\nconst a = 1\n```\nbot\n");
  await sleep(500);
  expect(await page.locator(".cm-lp-code-header").count()).toBe(0); // no header band for a plain fence
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

// #198 comment 752: (1) a PLAIN fence and an ATTRIBUTED fence share the SAME base card (background +
// rounded corners); attributes only LAYER a tab / line numbers / highlight on top. A tab flattens the
// card's top-left corner; a plain fence keeps it rounded. (2) Source mode is fully raw — no code-block
// decoration at all (no card background, tab, number or highlight). Verified in a real browser.
test("#198 comment 752: plain & attributed fences share one card base; Source is fully raw", async ({ browser }) => {
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
    const plain = firsts.find((e) => !e.classList.contains("cm-lp-code-tabbed"))!;
    const tabbed = firsts.find((e) => e.classList.contains("cm-lp-code-tabbed"))!;
    return {
      codeLines: q(".cm-lp-code-line").length,
      firsts: firsts.length,
      lasts: q(".cm-lp-code-last").length,
      tabbed: q(".cm-lp-code-tabbed").length,
      plainTopLeft: plain ? getComputedStyle(plain).borderTopLeftRadius : null,
      tabbedTopLeft: tabbed ? getComputedStyle(tabbed).borderTopLeftRadius : null,
    };
  });

  // Live: BOTH fences are carded (2 firsts / 2 lasts / all base cm-lp-code-line); only the attributed
  // fence's first line is tabbed. Plain keeps a rounded top-left; the tabbed one is flattened for the tab.
  const live = await m();
  expect(live.firsts).toBe(2);
  expect(live.lasts).toBe(2);
  expect(live.codeLines).toBe(4);
  expect(live.tabbed).toBe(1);
  expect(live.plainTopLeft).not.toBe("0px"); // plain fence: rounded card corner
  expect(live.tabbedTopLeft).toBe("0px"); // attributed fence: flattened under the tab

  // Source: fully raw — no code-block decoration whatsoever.
  await page.getByTestId("displaymode-source").click();
  await sleep(300);
  const src = await m();
  expect(src.codeLines).toBe(0);
  expect(src.firsts).toBe(0);
  expect(await page.locator(".cm-lp-code-tab").count()).toBe(0);
  expect(await page.locator(".cm-lp-code-hl").count()).toBe(0);
});
