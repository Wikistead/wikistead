import { test, expect } from "@playwright/test";
import { enterEdit, openScratch, sleep } from "../helpers";

// #223: pasting a URL in the body auto-linkifies to Markdown [url](url) AND renders as a clickable link;
// a dangerous scheme stays plain. Uses a REAL clipboard + Ctrl+V (not a synthetic ClipboardEvent) and
// asserts the RENDERED result (the reviewer's exact critique: prove the real paste path + insertion +
// rendering, not just the pure helper).

async function ctx(browser: any) {
  const c = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  return c.newPage();
}
async function realPaste(page: any, text: string) {
  await page.evaluate((t: string) => navigator.clipboard.writeText(t), text);
  await page.keyboard.press("Control+v");
  await sleep(300);
}
async function caretToTop(page: any) { // click line 1 ("anchor") to move the caret off the pasted line 2
  await page.locator("[data-pane=preview] .cm-line").first().click();
  await sleep(300);
}
const linkOf = (page: any) => page.evaluate(() => {
  const l = document.querySelector("[data-pane=preview] .cm-lp-link") as HTMLElement | null;
  return l ? { text: l.textContent, href: l.getAttribute("data-href") } : null;
});
const rawText = (page: any) => page.locator("[data-pane=preview] .cm-content").innerText();

test("#223: pasting an http(s) URL inserts [url](url) that renders as a clickable link (not blank)", async ({ browser }) => {
  const page = await ctx(browser);
  await openScratch(page, "paste-url");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.type("anchor\n"); // line 1, caret on line 2
  await realPaste(page, "https://example.com/x");
  expect(await rawText(page)).toContain("[https://example.com/x](https://example.com/x)"); // source stays Markdown
  await caretToTop(page);
  const link = await linkOf(page);
  expect(link?.href).toBe("https://example.com/x"); // rendered as a clickable link…
  expect(link?.text).toBe("https://example.com/x"); // …showing the URL (NOT blank — the #223 fix)
});

test("#223: pasting a javascript: URL does NOT linkify (stays plain text)", async ({ browser }) => {
  const page = await ctx(browser);
  await openScratch(page, "paste-js");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.type("anchor\n");
  await realPaste(page, "javascript:alert(1)");
  const text = await rawText(page);
  expect(text).toContain("javascript:alert(1)"); // present as plain text
  expect(text).not.toContain("](javascript:"); // but NEVER as a link target
  await caretToTop(page);
  expect(await linkOf(page)).toBeNull(); // and no clickable link produced
});

test("#223: selected text + pasted URL wraps the selection as the link anchor", async ({ browser }) => {
  const page = await ctx(browser);
  await openScratch(page, "paste-sel");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.type("anchor\n");
  await page.keyboard.type("my site");
  await page.keyboard.press("Shift+Home"); // select "my site" on line 2
  await realPaste(page, "https://example.com");
  expect(await rawText(page)).toContain("[my site](https://example.com)");
  await caretToTop(page);
  const link = await linkOf(page);
  expect(link?.text).toBe("my site");
  expect(link?.href).toBe("https://example.com");
});
