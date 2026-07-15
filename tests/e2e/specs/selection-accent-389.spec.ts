import { test, expect, type Page } from "@playwright/test";

// #389 review return: selected radios/checkboxes/switches used the shadcn `accent` utility,
// which tokens.css aliases to --panel-2 (a faint hover grey) — every selected state washed out.
// Selection states must use the BRAND accent (`primary` utility = --accent). The real settings UI
// renders through the DS wrapper (src/ui/RadioGroup.tsx list variant → data-slot=radio-group-choice
// with an inner dot span), so this pins the wrapper's computed colors in a real browser, light AND
// dark: the checked choice's dot equals the resolved --accent and is NOT the resolved --panel-2.
async function resolvedVars(page: Page): Promise<{ accent: string; panel2: string }> {
  return page.evaluate(() => {
    const probe = document.createElement("div");
    probe.style.position = "absolute";
    document.body.appendChild(probe);
    const resolve = (v: string) => {
      probe.style.backgroundColor = `var(${v})`;
      return getComputedStyle(probe).backgroundColor;
    };
    const out = { accent: resolve("--accent"), panel2: resolve("--panel-2") };
    probe.remove();
    return out;
  });
}

async function checkSurface(page: Page) {
  await page.goto("/settings/account/editor");
  const choices = page.locator("[data-slot=radio-group-choice]");
  await choices.first().waitFor({ timeout: 10000 });
  const { accent, panel2 } = await resolvedVars(page);
  expect(accent).not.toBe(panel2); // sanity: the two tokens differ (else the pin proves nothing)

  await choices.first().click();
  const checked = page.locator('[data-slot=radio-group-choice][data-state="checked"]').first();
  await expect(checked).toBeVisible();
  // list variant structure: choice > span(circle) > span(dot); the dot carries the selection color
  const dot = checked.locator("span > span").first();
  const dotBg = await dot.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(dotBg).toBe(accent);
  expect(dotBg).not.toBe(panel2);
  // the row border also flips to the brand accent when checked (poll: 120ms color transition)
  await expect
    .poll(() => checked.evaluate((el) => getComputedStyle(el).borderTopColor), { timeout: 3000 })
    .toBe(accent);
}

test("#389: selected radio dot uses the BRAND accent (light)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await page.addInitScript(() => localStorage.setItem("wks.theme", "light"));
  await checkSurface(page);
});

test("#389: selected radio dot uses the BRAND accent (dark)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await page.addInitScript(() => localStorage.setItem("wks.theme", "dark"));
  await checkSurface(page);
});
