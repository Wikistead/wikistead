import { test, expect, type Page } from "@playwright/test";
import { enterEdit, openScratch, sleep } from "../helpers";

// #455: empty-macro placeholders — ONE localized wording pattern across macros, full-width boxes
// (the diagram centre class shrank them to content width), and the advertised click actually
// ENTERS the macro (the old branch said "click to edit" while wiring nothing).
test("#455: empty placeholders share one wording pattern, sit full-width, and click enters the macro", async ({ browser }) => {
  const page: Page = await (await browser.newContext()).newPage();
  await openScratch(page, `empty455-${Date.now()}`);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  // one empty diagram (used to centre-shrink), one empty directive (full width already)
  await page.keyboard.insertText("```mermaid\n```\n\n:::embed-external\n:::\n\nbelow\n");
  await sleep(400);
  await page.getByText("below", { exact: true }).click();
  await sleep(400);

  const empties = page.getByTestId("macro-empty");
  await expect(empties).toHaveCount(2);

  // 1. one wording pattern (localized, Ctrl+↵ based) — never "click to edit" or "✎ button"
  const texts = await empties.allTextContents();
  for (const t of texts) {
    expect(t, `unified pattern (got "${t}")`).toMatch(/Ctrl\+↵ to (edit|open|add)|Ctrl\+↵ で/);
    expect(t).not.toContain("✎");
    expect(t.toLowerCase()).not.toContain("click");
  }

  // 2. FULL WIDTH: both placeholder boxes span (about) the same width as the content column
  // the mermaid one must not centre-shrink to its text width.
  const content = (await page.locator("[data-pane=preview] .cm-content").boundingBox())!;
  const wraps = page.locator("[data-pane=preview] .cm-lp-macro-wrap", { has: page.getByTestId("macro-empty") });
  await expect(wraps).toHaveCount(2);
  for (let i = 0; i < 2; i++) {
    const b = (await wraps.nth(i).boundingBox())!;
    expect(b.width, `placeholder ${i} spans the column`).toBeGreaterThan(content.width * 0.85);
  }

  // 3. the advertised entry is REAL: the shared ✎/Ctrl+↵ button on the empty wrap opens the
  // macro editor (mermaid → its source editUI) — no stale "click to edit" promises.
  await wraps.first().hover();
  await sleep(200);
  await wraps.first().locator(".cm-lp-macro-edit").first().click({ force: true });
  await expect(page.locator("[data-pane=preview] [data-testid=mermaid-edit-src]")).toBeVisible({ timeout: 5000 });
});

// Non-regression: a RENDERED diagram still centres (the #255 behaviour the empty fix must not touch).
test("#455: a rendered diagram keeps its centre alignment", async ({ browser }) => {
  const page: Page = await (await browser.newContext()).newPage();
  await openScratch(page, `empty455-c-${Date.now()}`);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("```mermaid\nflowchart TD\n  A-->B\n```\n\nbelow\n");
  await sleep(600);
  await page.getByText("below", { exact: true }).click();
  await sleep(600);
  const wrap = page.locator("[data-pane=preview] .cm-lp-macro-wrap").first();
  await expect(wrap).toHaveClass(/cm-lp-align-center/, { timeout: 8000 });
});
