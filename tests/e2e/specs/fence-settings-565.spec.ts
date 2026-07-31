import { test, expect, type Page } from "@playwright/test";
import { openScratch, enterEdit, sleep } from "../helpers";

const docText = (p: Page) => p.evaluate(() => {
  const ed = document.querySelector("[data-pane=preview] .cm-editor") as { cmView?: { view?: unknown } } | null;
  const view = (ed?.cmView?.view ?? (document.querySelector("[data-pane=preview] .cm-content") as { cmTile?: { view?: unknown } } | null)?.cmTile?.view) as
    { state: { doc: { toString(): string } } };
  return view.state.doc.toString();
});

// #565: bug 1 (mouse-close discards the typed title — the capture-phase dismiss outran blur/change)
// and bug 2 (a language-less fence misreads its first attribute as the language, and the edit surface
// only rendered header chrome for language-led fences), driven end to end in a real browser.
async function seedBareFence(page: Page) {
  await openScratch(page, `fence565-${Date.now()}`);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("```\nconst a = 1\n```\n\nbelow\n");
  await sleep(600);
}

test("#565: a title typed then mouse-closed lands in the doc and renders as a filename tab", async ({ page }) => {
  await seedBareFence(page);
  await page.getByText("const a = 1", { exact: true }).click({ button: "right" });
  await expect(page.getByTestId("ctx-item-codesettings")).toBeVisible({ timeout: 8000 });
  await page.getByTestId("ctx-item-codesettings").click();
  await expect(page.getByTestId("fence-settings-panel")).toBeVisible({ timeout: 8000 });

  await page.getByTestId("macro-setting-title").fill("AA");
  await page.getByText("below", { exact: true }).click(); // outside click = the lossy path pre-fix
  await expect(page.getByTestId("fence-settings-panel")).toHaveCount(0, { timeout: 5000 });
  await sleep(400);

  // bug 1: the commit happened (the doc carries the title even though the panel was mouse-closed)
  const doc = await docText(page);
  expect(doc, "outside-click close still commits").toContain('title="AA"');
  // bug 2: the panel's own lang="" write parses back as a title on the rendered fence chrome
  await expect(page.locator(".cm-lp-code-title").first()).toHaveText("AA", { timeout: 5000 });
});

test("#565: showLineNumbers-only fence numbers its lines", async ({ page }) => {
  await openScratch(page, `fence565b-${Date.now()}`);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("```showLineNumbers\nconst a = 1\nconst b = 2\n```\n\nbelow\n");
  await sleep(600);
  await page.getByText("below", { exact: true }).click();
  await sleep(300);
  expect(await page.locator(".cm-lp-code-numbered").count(), "line numbers render").toBeGreaterThanOrEqual(2);
});
