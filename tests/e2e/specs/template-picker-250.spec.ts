import { test, expect } from "@playwright/test";
import { enterEdit, openScratch, sleep } from "../helpers";

// #250 / ADR-110: create a page FROM a template via the sidebar split- ▾ picker. Save a page as a
// personal template, open the picker, preview it, and create — the new draft opens in edit seeded with the
// template body and titled by the template name. Real Chromium.
test("#250: the template picker creates a page seeded from the template", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  const src = await openScratch(page, `pick-src-${Date.now()}`);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("# Retro template\n\n- went well\n");
  await sleep(300);
  await page.getByTestId("publish-page").click();
  await sleep(700);

  // Save it as a personal template.
  await page.goto(`/p/${src}`);
  await page.waitForSelector("[data-pane=preview] .cm-content");
  await page.getByTestId("page-overflow-trigger").click();
  await page.getByTestId("save-template-open").click();
  await page.getByTestId("template-name").fill("Retro Template");
  await page.getByTestId("save-template-submit").click();
  await sleep(500);

  // Open the picker from the sidebar split- ▾, preview, and use it.
  await page.getByTestId("new-page-from-template").click();
  await page.waitForSelector("[data-testid=template-picker]");
  const item = page.getByTestId("template-picker-item").filter({ hasText: "Retro Template" }).first();
  await expect(item).toBeVisible({ timeout: 8000 });
  await item.click();
  // Sanitized preview renders the template's H1.
  await expect(page.getByTestId("template-picker-preview-body").locator("h1")).toHaveText("Retro template", { timeout: 8000 });
  await page.getByTestId("template-picker-use").click();

  // A new draft opens in edit, seeded with the template body.
  await page.waitForURL(/\/p\/.*edit=1/, { timeout: 8000 });
  await page.waitForSelector("[data-pane=preview] .cm-content");
  await sleep(500);
  await expect(page.locator("[data-pane=preview] .cm-content")).toContainText("Retro template");
  await expect(page.locator("[data-pane=preview] .cm-content")).toContainText("went well");
});

// #267: the picker preview renders first-party macros (callout/columns/…) through previewMacroRegistry so
// they look RENDERED, not a wall of degrade-to-source; the preview scrolls internally (the dialog never
// exceeds the viewport); and the client preview stays XSS-safe — a top-level <script> is neutralized AND
// the one TRUSTED-passthrough macro (`:::table`) is EXCLUDED, so a malicious table body degrades to safe
// source instead of injecting raw HTML. Real Chromium.
test("#267: template preview renders macros (not source), scrolls, and stays XSS-safe", async ({ browser }) => {
  const page = await (await browser.newContext({ viewport: { width: 1100, height: 720 } })).newPage();
  const src = await openScratch(page, `pick267-${Date.now()}`);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  // A callout (renders), a MALICIOUS :::table (must NOT render its raw HTML), a top-level <script>, and a
  // long tail so the preview must scroll.
  const long = Array.from({ length: 40 }, (_, i) => `Paragraph line ${i} lorem ipsum dolor sit amet.`).join("\n\n");
  await page.keyboard.insertText(
    `# Macro template\n\n:::note\nHello callout\n:::\n\n:::table\n<img src=x onerror="window.__xss267=1">\n:::\n\n<script>window.__xss267=1</script>\n\n${long}\n`,
  );
  await sleep(400);
  await page.getByTestId("publish-page").click();
  await sleep(700);

  await page.goto(`/p/${src}`);
  await page.waitForSelector("[data-pane=preview] .cm-content");
  await page.getByTestId("page-overflow-trigger").click();
  await page.getByTestId("save-template-open").click();
  await page.getByTestId("template-name").fill("Macro Template");
  await page.getByTestId("save-template-submit").click();
  await sleep(500);

  await page.getByTestId("new-page-from-template").click();
  await page.waitForSelector("[data-testid=template-picker]");
  await page.getByTestId("template-picker-item").filter({ hasText: "Macro Template" }).first().click();
  const preview = page.getByTestId("template-picker-preview-body");
  await expect(preview.locator("h1")).toHaveText("Macro template", { timeout: 8000 });

  // (1) a first-party macro RENDERS (not degrade-to-source): the callout is a rendered wrapper and the raw
  // ::: fence text for it does NOT appear.
  await expect(preview.locator(".callout-note")).toHaveCount(1);
  expect(await preview.innerText()).not.toContain(":::note");

  // (2) XSS-safe: neither the <script> NOR the malicious :::table injected anything, and nothing executed.
  await expect(preview.locator("script")).toHaveCount(0);
  await expect(preview.locator("img[onerror]")).toHaveCount(0);
  await sleep(150); // give any (unwanted) onerror a chance to fire before asserting it did not
  expect(await page.evaluate(() => (window as unknown as { __xss267?: number }).__xss267)).toBeUndefined();

  // (3) the preview scrolls internally — the long body is scrollable and the dialog stays within the
  // viewport (the max-h clamp makes the inner overflow-auto engage instead of the dialog overflowing).
  const previewPane = page.getByTestId("template-picker-preview");
  expect(await previewPane.evaluate((el) => el.scrollHeight > el.clientHeight + 4)).toBe(true);
  const dlg = (await page.getByTestId("template-picker").boundingBox())!;
  expect(dlg.y).toBeGreaterThanOrEqual(-1);
  expect(dlg.y + dlg.height).toBeLessThanOrEqual(page.viewportSize()!.height + 1);
});
