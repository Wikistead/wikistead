import { test, expect } from "@playwright/test";
import { openScratch, enterEdit, sleep } from "../helpers";

// #158-C2 / ADR-052: code fences are highlighted in the Everforest palette via --hl-* tokens.
// Verify the keyword colour token is actually applied to a token in a ```js block.
test("code fence is syntax-highlighted with the Everforest keyword token", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "hl");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("```js\nconst answer = 42\n```\n");
  await sleep(400);

  const result = await page.evaluate(() => {
    const root = getComputedStyle(document.documentElement).getPropertyValue("--hl-keyword").trim();
    // resolve the token to an rgb() the same way the browser computes span colours
    const probe = document.createElement("span");
    probe.style.color = root; document.body.appendChild(probe);
    const want = getComputedStyle(probe).color; probe.remove();
    // does any highlighted span in the editor use that colour? (the `const` keyword)
    const spans = Array.from(document.querySelectorAll("[data-pane=preview] .cm-content span"));
    const hit = spans.some((s) => getComputedStyle(s).color === want && (s.textContent ?? "").trim().length > 0);
    return { want, hit, anySpans: spans.length };
  });
  expect(result.anySpans).toBeGreaterThan(0); // the fence produced highlight spans
  expect(result.hit).toBe(true); // a token is painted with the --hl-keyword colour
});
