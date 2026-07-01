import { test, expect } from "@playwright/test";
import { enterEdit, openScratch, sleep } from "../helpers";

// P3 / #171: a fenced code block with a known language is syntax-highlighted. The language parser
// loads DYNAMICALLY (import on first use), so we POLL for the token spans rather than assume they're
// present synchronously. Highlighting wraps tokens in styled spans.
//
// Uses a REAL throwaway page (unique id, not the shared demo doc) so this test's
// transient presence caret cannot linger as a ghost into other demo-based specs.
test("fenced code block is syntax-highlighted (token spans appear)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "code");
  await enterEdit(page);

  await page.click("[data-pane=preview] .cm-content");
  for (const line of ["```js", 'const greeting = "hello";', "function add(a, b) { return a + b; }", "```", "below"]) {
    await page.keyboard.type(line);
    await page.keyboard.press("Enter");
  }
  await sleep(300);

  // CM's highlighter wraps keywords/strings/etc. in styled spans inside the code lines. The parser
  // loads async (#171 dynamic import), so poll until the token spans appear. Plain text would have none.
  await expect.poll(
    () => page.locator("[data-pane=preview] .cm-lp-code-line span").count(),
    { timeout: 4000 },
  ).toBeGreaterThanOrEqual(3);

  // The ``` fence lines are NOT tinted — only the 2 content lines carry the code
  // background (a fence line would otherwise render as an empty tinted bar).
  expect(await page.locator("[data-pane=preview] .cm-lp-code-line").count()).toBe(2);
});
