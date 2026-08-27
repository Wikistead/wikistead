import { test, expect } from "@playwright/test";
import { WEB_REAL_PORT } from "../helpers";

// #442: the header and the sign-in card render the SAME TenantBrand lockup. The header's old copy
// let the name span inherit a line-height taller than the 22px mark (arbitrary text-[15px] sets no
// line-height), visually mis-centring the title. Pin the glyph-box behaviour: leading-none
// (computed line-height == font-size) and the mark/text vertical centres coincide.
test("#442: header brand name is glyph-box centred against the mark (leading-none)", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("brand")).toBeVisible();
  const m = await page.evaluate(() => {
    const mark = document.querySelector('[data-testid="brand-mark"], [data-testid="brand-logo"]')!;
    const name = document.querySelector('[data-testid="brand"]')!;
    const mc = mark.getBoundingClientRect();
    const nc = name.getBoundingClientRect();
    const cs = getComputedStyle(name);
    return {
      delta: Math.abs(mc.top + mc.height / 2 - (nc.top + nc.height / 2)),
      lineHeight: parseFloat(cs.lineHeight),
      fontSize: parseFloat(cs.fontSize),
    };
  });
  expect(m.lineHeight, "leading-none: line-height equals font-size").toBeCloseTo(m.fontSize, 1);
  expect(m.delta, "mark and name vertical centres coincide").toBeLessThanOrEqual(1);
});

test("#442: the sign-in card uses the same lockup behaviour (real-auth web)", async ({ browser }) => {
  // The 5181 real-auth web shows the LoginScreen to an anonymous visitor.
  const page = await (await browser.newContext()).newPage();
  await page.goto(`http://dev.localhost:${WEB_REAL_PORT}/`);
  await expect(page.getByTestId("login-brand")).toBeVisible({ timeout: 15_000 });
  const m = await page.evaluate(() => {
    const name = document.querySelector('[data-testid="login-brand"]')!;
    const cs = getComputedStyle(name);
    return { lineHeight: parseFloat(cs.lineHeight), fontSize: parseFloat(cs.fontSize) };
  });
  expect(m.lineHeight, "login name is leading-none too").toBeCloseTo(m.fontSize, 1);
});
