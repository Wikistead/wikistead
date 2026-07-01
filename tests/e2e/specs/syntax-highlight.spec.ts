import { test, expect } from "@playwright/test";
import { openScratch, enterEdit, sleep } from "../helpers";

// #158-C2 / #171 / ADR-052: code fences are highlighted in the Everforest palette via --hl-* tokens,
// with BROAD language coverage loaded DYNAMICALLY (a fence's @codemirror/lang-* / legacy mode is
// imported on first use). A brief unhighlighted flash is accepted, so tests POLL for the colour after
// the async parser resolves. An UNKNOWN language stays plain (no crash).

// Does any span in the editor render in the --hl-keyword colour (i.e. a keyword got highlighted)?
async function keywordColoured(page: import("@playwright/test").Page): Promise<boolean> {
  return page.evaluate(() => {
    const root = getComputedStyle(document.documentElement).getPropertyValue("--hl-keyword").trim();
    const probe = document.createElement("span");
    probe.style.color = root; document.body.appendChild(probe);
    const want = getComputedStyle(probe).color; probe.remove();
    const spans = Array.from(document.querySelectorAll("[data-pane=preview] .cm-content span"));
    return spans.some((s) => getComputedStyle(s).color === want && (s.textContent ?? "").trim().length > 0);
  });
}

test("code fences across languages are highlighted (dynamic load), unknown stays plain", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "hl");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");

  // A language whose parser must load dynamically (not in the old 3-lang sync set): Rust.
  await page.keyboard.insertText("```rust\nfn main() { let x = 42; }\n```\n");
  // Poll: the lezer parser imports async, then the keyword colour appears.
  await expect.poll(() => keywordColoured(page), { timeout: 4000 }).toBe(true);

  // A second, distinct language (C++) also loads + colours.
  await page.keyboard.press("Control+End");
  await page.keyboard.insertText("\n```cpp\nint main() { return 0; }\n```\n");
  await expect.poll(() => keywordColoured(page), { timeout: 4000 }).toBe(true);

  // An UNKNOWN language must NOT break the editor (plain monospace, no crash). The doc still shows it.
  await page.keyboard.press("Control+End");
  await page.keyboard.insertText("\n```foobarlang\nsome plain text here\n```\n");
  await sleep(400);
  expect(await page.locator("[data-pane=preview] .cm-content").innerText()).toContain("some plain text here");
});
