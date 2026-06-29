import { test, expect } from "@playwright/test";
import { openScratch, enterEdit, sleep } from "../helpers";

// #158-C3 / ADR-052: $…$ inline and $$…$$ block render via KaTeX as atoms; caret-in reveals raw.
test("inline + block math render via KaTeX; caret-in reveals the raw TeX", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "math");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("before $E=mc^2$ after\n\n$$\\int_0^1 x\\,dx$$\n\ntail\n");
  await sleep(400);
  await page.keyboard.press("Control+End"); // caret away from the formulas
  await sleep(200);

  // both render: a KaTeX element exists inside the inline + block math widgets.
  await expect(page.locator("[data-pane=preview] [data-testid=math-inline] .katex").first()).toBeVisible();
  await expect(page.locator("[data-pane=preview] [data-testid=math-block] .katex").first()).toBeVisible();
  // the raw $…$ source is hidden while rendered.
  expect(await page.locator("[data-pane=preview] .cm-content").innerText()).not.toContain("E=mc^2");

  // click into the inline formula → reveal raw TeX (editable), widget drops.
  await page.locator("[data-pane=preview] [data-testid=math-inline]").first().click();
  await sleep(200);
  expect(await page.locator("[data-pane=preview] .cm-content").innerText()).toContain("E=mc^2");
});

// #158-C3 XSS boundary: KaTeX runs trust:false + strict, so a hostile \href (javascript:) must NOT
// produce a clickable javascript anchor, and no script element appears. (Hardening: the happy path
// alone wouldn't catch a trust-config regression.)
test("malicious TeX (\\href javascript:) renders no dangerous anchor / no script", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "mathxss");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("x $\\href{javascript:alert(1)}{click}$ y\n\ntail\n");
  await sleep(400);
  await page.keyboard.press("Control+End");
  await sleep(200);
  const danger = await page.evaluate(() => {
    const root = document.querySelector("[data-pane=preview]")!;
    const jsAnchor = Array.from(root.querySelectorAll("a")).some((a) => (a.getAttribute("href") ?? "").trim().toLowerCase().startsWith("javascript:"));
    return { jsAnchor, script: !!root.querySelector("script"), onerror: root.innerHTML.includes("onerror=") };
  });
  expect(danger.jsAnchor).toBe(false); // trust:false → no javascript: href survives
  expect(danger.script).toBe(false);
  expect(danger.onerror).toBe(false);
});

// #158-C3 × #164: math honors the display mode. Source mode shows raw TeX always (force-reveal),
// even with the caret away — verifying math.ts consults the displayMode facet (not just selection).
test("Source display mode shows raw TeX (math.ts respects displayMode)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "mathmode");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("see $E=mc^2$ here\n\ntail\n");
  await sleep(400);
  await page.keyboard.press("Control+End");
  await sleep(200);
  const content = () => page.locator("[data-pane=preview] .cm-content").innerText();
  // Live (default): rendered, raw hidden.
  expect(await content()).not.toContain("E=mc^2");
  // → Source: raw TeX shown even though the caret is elsewhere.
  const toggle = page.getByTestId("displaymode-toggle");
  for (let i = 0; i < 3 && (await toggle.getAttribute("data-mode")) !== "source"; i++) { await toggle.click(); await sleep(150); }
  await page.keyboard.press("Control+End"); await sleep(200);
  expect(await content()).toContain("E=mc^2"); // force-revealed in Source
});

// #158-C3 boundary: a `$` inside code (inline `code` / fenced block) is LITERAL, not math — the
// inCode skip (syntax-tree check) must hold so code samples containing $ aren't mangled.
test("a $…$ inside inline code or a fenced block is NOT rendered as math", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "mathcode");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("inline `cost is $5 and $9` here\n\n```sh\necho $HOME and $PATH\n```\n\ntail\n");
  await sleep(400);
  await page.keyboard.press("Control+End");
  await sleep(200);
  // no math widget should have formed from the $ inside code.
  expect(await page.locator("[data-pane=preview] [data-testid=math-inline]").count()).toBe(0);
  expect(await page.locator("[data-pane=preview] [data-testid=math-block]").count()).toBe(0);
});
