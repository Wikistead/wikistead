import { test, expect, type Locator, type Page } from "@playwright/test";
import { openDemo, enterEdit, resetDoc, sleep } from "../helpers";

// #612 (user request): the format buttons PREVIEW their effect — "
// Measured from COMPUTED STYLE in a real browser, per the acceptance: a class name proves nothing about
// what paints (the Tailwind-undefined-token lesson), and marker legibility is a contrast, not a colour.
const relLum = (r: number, g: number, b: number): number => {
  const f = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};

async function assertPreviewStyles(scope: Locator, page: Page, surface: string) {
  const styleOf = (sel: string) =>
    scope.locator(sel).first().evaluate((el) => {
      const cs = getComputedStyle(el);
      return { weight: cs.fontWeight, style: cs.fontStyle, deco: cs.textDecorationLine, bg: cs.backgroundColor, fg: cs.color };
    });
  const bold = await styleOf(".lp-btn-preview-bold");
  expect(Number(bold.weight), `${surface}: the bold button IS bold`).toBeGreaterThanOrEqual(600);
  const italic = await styleOf(".lp-btn-preview-italic");
  expect(italic.style, `${surface}: the italic button slants`).toBe("italic");
  const strike = await styleOf(".lp-btn-preview-strike");
  expect(strike.deco, `${surface}: the strike button is struck through`).toContain("line-through");
}

async function assertHighlightLegible(scope: Locator, theme: string) {
  const m = await scope.locator(".lp-btn-preview-highlight").first().evaluate((el) => {
    // the marker tint is semi-transparent — composite it over the BUTTON's own background to get the
    // colour a person actually reads against
    const cs = getComputedStyle(el);
    // Chromium serialises color-mix results as `color(srgb r g b / a)` (0-1 floats), NOT rgba
    // the #598 measurement trap, handled here on purpose rather than rediscovered
    const parse = (c: string) => {
      const srgb = /color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)(?: \/ ([\d.]+))?\)/.exec(c);
      if (srgb) return { r: +srgb[1]! * 255, g: +srgb[2]! * 255, b: +srgb[3]! * 255, a: srgb[4] === undefined ? 1 : +srgb[4] };
      const m2 = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/.exec(c);
      return m2 ? { r: +m2[1]!, g: +m2[2]!, b: +m2[3]!, a: m2[4] === undefined ? 1 : +m2[4] } : null;
    };
    const fg = parse(cs.color);
    const tint = parse(cs.backgroundColor);
    const base = parse(getComputedStyle(el.closest("button")!).backgroundColor);
    return { fg, tint, base };
  });
  expect(m.tint, `${theme}: the marker button actually paints a background`).not.toBeNull();
  expect(m.tint!.a, `${theme}: a real tint, not transparent`).toBeGreaterThan(0.05);
  // composite tint over the button base, then contrast against the glyph colour
  const comp = (c: number, b: number, a: number) => Math.round(c * a + b * (1 - a));
  const bgR = comp(m.tint!.r, m.base!.r, m.tint!.a), bgG = comp(m.tint!.g, m.base!.g, m.tint!.a), bgB = comp(m.tint!.b, m.base!.b, m.tint!.a);
  const l1 = relLum(m.fg!.r, m.fg!.g, m.fg!.b), l2 = relLum(bgR, bgG, bgB);
  const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  expect(ratio, `${theme}: the marker glyph stays readable on its tint (contrast ${ratio.toFixed(2)})`).toBeGreaterThanOrEqual(3);
}

test("#612: the selection bubble's buttons preview their effects, in both themes", async ({ page }) => {
  test.setTimeout(120_000);
  await openDemo(page);
  await enterEdit(page);
  await resetDoc(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.type("preview me");
  await page.keyboard.press("Home");
  for (let i = 0; i < 7; i++) await page.keyboard.press("Shift+ArrowRight");
  const bubble = page.getByTestId("format-bubble");
  await expect(bubble).toBeVisible();

  await assertPreviewStyles(bubble, page, "bubble");
  // link: an icon, never the word (#544)
  await expect(bubble.locator(".lp-btn-icon svg"), "the link button carries an svg").toHaveCount(1);
  await expect(bubble.getByText("Link", { exact: true })).toHaveCount(0);
  await assertHighlightLegible(bubble, "light");

  // dark theme: same buttons, still legible. The toggle re-renders; re-select to raise the bubble.
  await page.emulateMedia({ colorScheme: "dark" });
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  await sleep(200);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.press("Home");
  for (let i = 0; i < 7; i++) await page.keyboard.press("Shift+ArrowRight");
  await expect(bubble).toBeVisible();
  await assertHighlightLegible(bubble, "dark");
  await page.evaluate(() => document.documentElement.removeAttribute("data-theme"));

  // non-regression: the bold button still bolds (chrome only, command unchanged)
  await bubble.locator(".lp-btn-preview-bold").click();
  await sleep(200);
  await expect
    .poll(async () => page.locator("[data-pane=preview] .cm-content").innerText(), { timeout: 4000 })
    .toContain("**preview**");
});

test("#612: the table-cell bar wears the same previews (no surface left behind)", async ({ page }) => {
  test.setTimeout(120_000);
  await openDemo(page);
  await enterEdit(page);
  await resetDoc(page);
  await page.click("[data-pane=preview] .cm-content");
  // the proven rich-edit opt-in flow (same as cell-inline-format.spec.ts)
  await page.keyboard.insertText("| A | B |\n| --- | --- |\n| 1 | 2 |\n\nbelow\n");
  await sleep(300);
  await page.locator("[data-pane=preview] table.cm-lp-table").click();
  await sleep(150);
  await page.keyboard.press("Control+Enter");
  await expect(page.getByTestId("table-edit")).toBeVisible();
  const cell = page.getByTestId("table-edit").locator("td").first();
  await cell.dblclick();
  await sleep(100);
  await cell.evaluate((el) => {
    const r = document.createRange();
    r.selectNodeContents(el);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(r);
    el.dispatchEvent(new Event("selectionchange", { bubbles: true }));
    document.dispatchEvent(new Event("selectionchange"));
  });
  await sleep(200);
  const bar = page.getByTestId("cell-format-bar");
  await expect(bar).toBeVisible();
  await assertPreviewStyles(bar, page, "cell bar");
  await expect(bar.locator(".lp-btn-icon svg"), "the cell link button is an icon too").toHaveCount(1);
  await expect(bar.getByText("Link", { exact: true })).toHaveCount(0);
});
