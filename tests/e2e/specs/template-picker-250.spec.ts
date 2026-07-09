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

// #267: the picker preview renders via renderMarkdownToDom — the SAME client DOM renderer the public
// reader uses — so ALL first-party macros RENDER: a callout recurses its body markdown, a NESTED :::tabs shows
// BOTH tabs (the resolver corrects lezer's early-close), and a `:::table` builds a real table. It stays
// XSS-safe (text nodes from an allowlist, never innerHTML): a top-level <script> and a malicious <img onerror>
// inside a table cell are neutralized. The preview scrolls internally (the dialog never exceeds the viewport).
test("#267: template preview renders ALL macros (callout/tabs/table), scrolls, and stays XSS-safe", async ({ browser }) => {
  const page = await (await browser.newContext({ viewport: { width: 1100, height: 720 } })).newPage();
  const src = await openScratch(page, `pick267-${Date.now()}`);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  // A callout with **bold** body, a NESTED :::tabs (2 tabs — the early-close case), a MALICIOUS :::table
  // (renders as a real table but the onerror cell is inert), a top-level <script>, and a long scroll tail.
  const long = Array.from({ length: 40 }, (_, i) => `Paragraph line ${i} lorem ipsum dolor sit amet.`).join("\n\n");
  // #267bounce: a HEAVY body — a WIDE 12-column pipe table + a display-math block + a second mermaid
  // on top of the tall prose — is what burst the preview pane out of the dialog (right + no vertical scroll).
  const wideCols = Array.from({ length: 12 }, (_, i) => `Col ${i}`).join(" | ");
  const wideSep = Array.from({ length: 12 }, () => "---").join(" | ");
  const wideRow = Array.from({ length: 12 }, (_, i) => `v${i}`).join(" | ");
  const wide = `| ${wideCols} |\n| ${wideSep} |\n| ${wideRow} |`;
  await page.keyboard.insertText(
    `# Macro template\n\n:::note\nHello **bold** callout\n:::\n\n\`\`\`mermaid\nflowchart TD\n  A --> B\n\`\`\`\n\n::::tabs\n:::tab[One]\nAlpha\n:::\n:::tab[Two]\nBravo\n:::\n::::\n\n:::table\n<table><tr><td><img src=x onerror="window.__xss267=1"></td></tr></table>\n:::\n\n${wide}\n\n$$a^2 + b^2 = c^2$$\n\n\`\`\`mermaid\nflowchart LR\n  X --> Y --> Z\n\`\`\`\n\n<script>window.__xss267=1</script>\n\n${long}\n`,
  );
  await sleep(500);
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

  // (1) the callout RENDERS as a panel and its body markdown recurses (**bold** → <strong>); no raw ::: text.
  await expect(preview.locator("[data-testid=callout-panel]")).toHaveCount(1);
  await expect(preview.locator("[data-testid=callout-panel] strong")).toHaveText("bold");
  expect(await preview.innerText()).not.toContain(":::note");

  // (1b) #267point 1: the callout PANEL shows its BOX — a background tint + a left colour bar — even
  // though the preview is OUTSIDE .cm-editor (the tint/bar used to come only from the .cm-editor baseTheme,
  // so the box vanished in the preview). Global CSS now backs it: the panel has a non-transparent tint.
  const calloutBg = await preview.locator("[data-testid=callout-panel]").evaluate((el) => {
    const cs = getComputedStyle(el);
    return { bg: cs.backgroundColor, bar: cs.borderLeftWidth };
  });
  expect(calloutBg.bg, "callout panel has no background tint (the box is missing)").not.toBe("rgba(0, 0, 0, 0)");
  expect(calloutBg.bg).not.toBe("transparent");
  expect(parseFloat(calloutBg.bar), "callout panel has no left colour bar").toBeGreaterThan(0);

  // (1c) #267point 2: a rendered mermaid diagram is CENTERED by default (#255), matching the editor
  // md-render tags it cm-lp-align-center and the global align CSS (not the .cm-editor baseTheme) centers it.
  const mermaid = preview.locator(".cm-lp-mermaid").first();
  await expect(mermaid).toHaveClass(/cm-lp-align-center/);
  expect(await mermaid.evaluate((el) => getComputedStyle(el).alignItems)).toBe("center");

  // (2) the NESTED :::tabs renders BOTH tabs (early-close corrected) and leaks no literal ":::".
  const tabs = preview.locator("[data-testid=macro-tabs]");
  await expect(tabs).toHaveCount(1);
  await expect(tabs.locator(".cm-lp-tab")).toHaveText(["One", "Two"]);
  expect(await preview.innerText()).not.toContain(":::");

  // (3) the :::table RENDERS as a real <table> (not source), and its malicious onerror cell is inert.
  await expect(preview.locator("table.cm-lp-table")).toHaveCount(1);

  // (4) XSS-safe: neither the <script> nor the table's <img onerror> injected anything or executed.
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

  // #267bounce: the preview pane's VISIBLE box must stay within the dialog on BOTH axes — the heavy
  // body (wide table + math + 2 mermaids + tall prose) used to burst it right and grow it to ~4000px tall.
  // (boundingBox reports the un-clipped layout size, so measure the client box the user actually sees.)
  const pane = await previewPane.evaluate((el) => ({ cw: el.clientWidth, ch: el.clientHeight, sw: el.scrollWidth, sh: el.scrollHeight }));
  const dlgClient = await page.getByTestId("template-picker").evaluate((el) => ({ cw: el.clientWidth, ch: el.clientHeight }));
  expect(pane.cw, "preview pane is wider than the dialog (horizontal burst)").toBeLessThanOrEqual(dlgClient.cw);
  expect(pane.ch, "preview pane is taller than the dialog (vertical burst)").toBeLessThanOrEqual(dlgClient.ch);
  expect(pane.sh, "the tall content does not scroll inside the capped pane").toBeGreaterThan(pane.ch + 4);
});
