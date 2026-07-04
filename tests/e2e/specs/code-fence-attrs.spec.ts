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

  // Source mode: always raw (round-trip)
  await page.getByTestId("displaymode-source").click();
  await sleep(200);
  const src = await content(page).innerText();
  expect(src).toContain('title="app.ts"');
  expect(src).toContain("showLineNumbers");
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
