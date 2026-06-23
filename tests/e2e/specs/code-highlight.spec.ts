import { test, expect } from "@playwright/test";
import { enterEdit, sleep } from "../helpers";

// P3: a fenced code block with a known language is syntax-highlighted (CM's
// synchronous, curated language set — no async highlighter). Highlighting wraps
// tokens in styled spans, so we assert several token spans appear in the block.
//
// Uses a UNIQUE page (not the shared demo doc) so this test's transient presence
// caret cannot linger as a ghost into other demo-based specs.
test("fenced code block is syntax-highlighted (token spans appear)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await page.goto("/p/p3code");
  await page.waitForSelector("[data-pane=preview] .cm-content");
  await sleep(600);
  await enterEdit(page);

  await page.click("[data-pane=preview] .cm-content");
  for (const line of ["```js", 'const greeting = "hello";', "function add(a, b) { return a + b; }", "```", "below"]) {
    await page.keyboard.type(line);
    await page.keyboard.press("Enter");
  }
  await sleep(500);

  // CM's highlighter wraps keywords/strings/etc. in styled spans inside the code
  // lines. Plain (un-highlighted) text would have none.
  const tokenSpans = await page.locator("[data-pane=preview] .cm-lp-code-line span").count();
  expect(tokenSpans).toBeGreaterThanOrEqual(3);

  // The ``` fence lines are NOT tinted — only the 2 content lines carry the code
  // background (a fence line would otherwise render as an empty tinted bar).
  expect(await page.locator("[data-pane=preview] .cm-lp-code-line").count()).toBe(2);
});
