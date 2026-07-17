import { test, expect } from "@playwright/test";
import { openScratch, enterEdit, sleep } from "../helpers";

// #438two atom behaviours found on device alongside the vim-dd fix.
//  1) WYSIWYG frontmatter copy must carry the whole `---…---` fence (atomClipboard resolves atoms
//     from livePreview.blocks; addAtomic has pushed there since 09f319c, so this is an INVARIANT pin —
//     the reported drop did not reproduce; see the ticket comment).
//  2) The atom-selection RING class is cm-lp-atom-sel everywhere: the frontmatter widget shipped a
//     private "cm-lp-atom-selected" no CSS matches, and the callout panel had no ring logic at all.
//     Both red without the fix.

async function setUp(page: any, name: string, content: string) {
  await openScratch(page, name);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(content);
  await sleep(700);
  await page.locator("[role=radiogroup] [role=radio]").nth(3).click(); // WYSIWYG
  await sleep(600);
}

test("#438-2258 ①: WYSIWYG frontmatter atom copies the full fence; cut removes the whole block", async ({ browser }) => {
  const ctx = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  const page = await ctx.newPage();
  await setUp(page, "fm-copy-438", "---\ntags: [zap]\n---\n\nbody line\n\ntail\n");
  await page.locator(".cm-lp-frontmatter").first().click();
  await sleep(300);
  await page.keyboard.press("Control+c");
  await sleep(300);
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied, "copy carries the whole fence").toBe("---\ntags: [zap]\n---");
  await page.keyboard.press("Control+x");
  await sleep(400);
  const txt = await page.locator("[data-pane=preview] .cm-content").first().innerText();
  expect(txt, "cut removed the whole block").not.toContain("tags:");
  expect(txt).toContain("body line");
});

test("#438-2258 ②: frontmatter and callout atoms ring with the SHARED cm-lp-atom-sel when selected", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await setUp(page, "ring-438", "---\ntags: [zap]\n---\n\n:::warning[w]\ninner\n:::\n\ntail\n");
  // select the frontmatter atom (click parks the caret on it; WYSIWYG never reveals)
  await page.locator(".cm-lp-frontmatter").first().click();
  await sleep(300);
  await expect(page.locator(".cm-lp-frontmatter.cm-lp-atom-sel"), "frontmatter rings").toHaveCount(1);
  await expect(page.locator(".cm-lp-atom-selected"), "the private legacy class is gone").toHaveCount(0);
  // select the callout atom
  await page.locator(".cm-lp-callout-panel").first().click();
  await sleep(300);
  await expect(page.locator(".cm-lp-callout-panel.cm-lp-atom-sel"), "callout panel rings").toHaveCount(1);
  // the ring follows the caret away
  await page.getByText("tail", { exact: true }).click();
  await sleep(300);
  await expect(page.locator(".cm-lp-atom-sel"), "ring clears when the caret leaves").toHaveCount(0);
});
