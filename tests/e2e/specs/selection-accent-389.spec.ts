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

// #389 the dot centers in the circle by FLEX (never %-position + translate, whose top/left
// subpixel rounding drifts apart at fractional zoom). Pins the rect-center match at 1x AND a
// fractional deviceScaleFactor, and that the checked resting dot carries no transform (a persistent
// transform exempts it from device-pixel snapping — the residual paint-level off-center).
for (const dsf of [1, 1.25]) {
  test(`#389 radio dot rect-centers in its circle (dsf ${dsf})`, async ({ browser }) => {
    const page = await (await browser.newContext({ deviceScaleFactor: dsf })).newPage();
    await page.goto("/settings/account/editor");
    const choices = page.locator("[data-slot=radio-group-choice]");
    await choices.first().waitFor({ timeout: 10000 });
    const offs = await page.evaluate(() => {
      const out: { dx: number; dy: number; transform: string; state: string | null }[] = [];
      for (const choice of document.querySelectorAll("[data-slot=radio-group-choice]")) {
        const circle = choice.querySelector("span[class*=rounded-full][class*=border]");
        const dot = circle?.querySelector("span");
        if (!circle || !dot) continue;
        const c = circle.getBoundingClientRect(), d = dot.getBoundingClientRect();
        out.push({
          dx: Math.abs((d.left + d.right) / 2 - (c.left + c.right) / 2),
          dy: Math.abs((d.top + d.bottom) / 2 - (c.top + c.bottom) / 2),
          transform: getComputedStyle(dot).transform,
          state: choice.getAttribute("data-state"),
        });
      }
      return out;
    });
    expect(offs.length).toBeGreaterThan(1);
    for (const o of offs) {
      expect(o.dx, "dot horizontally centered").toBeLessThan(0.51);
      expect(o.dy, "dot vertically centered").toBeLessThan(0.51);
      if (o.state === "checked") expect(o.transform, "checked resting dot has NO transform (pixel-snaps)").toBe("none");
    }
  });
}
