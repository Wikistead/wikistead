import { test, expect } from "@playwright/test";
import { enterEdit, openScratch, sleep } from "../helpers";

// #223: pasting a URL in the body auto-linkifies to Markdown [url](url); a dangerous scheme stays plain.
// Drives a synthetic ClipboardEvent (constructing a real clipboard in Playwright needs permissions) so the
// CM paste handler runs exactly as it does for a real paste.
async function paste(page: any, text: string, html = "") {
  await page.evaluate(({ text, html }: { text: string; html: string }) => {
    const dt = new DataTransfer();
    dt.setData("text/plain", text);
    if (html) dt.setData("text/html", html);
    const el = document.querySelector("[data-pane=preview] .cm-content")!;
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, { text, html });
  await sleep(200);
}
const raw = (page: any) => page.locator("[data-pane=preview] .cm-content").innerText();

test("#223: pasting an http(s) URL inserts a Markdown link", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "paste-url");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await paste(page, "https://example.com/x");
  expect(await raw(page)).toContain("[https://example.com/x](https://example.com/x)");
});

test("#223: pasting a javascript: URL does NOT linkify (stays plain text)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "paste-js");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await paste(page, "javascript:alert(1)");
  const text = await raw(page);
  expect(text).toContain("javascript:alert(1)"); // present as plain text
  expect(text).not.toContain("](javascript:"); // but NEVER as a link target
});

test("#223: pasting a rich <a href> normalizes to [text](href)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "paste-rich");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await paste(page, "Docs", '<a href="https://example.com/p">Docs</a>');
  expect(await raw(page)).toContain("[Docs](https://example.com/p)");
});
