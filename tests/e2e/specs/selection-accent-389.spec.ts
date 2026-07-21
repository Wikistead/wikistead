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
  // #389the ring paints its own dot as a background gradient (one paint box, so the dot
  // cannot drift out of the ring at fractional zoom — see control-alignment-389.spec.ts). The colour
  // therefore lives in the gradient's stops, not in a child element's background-color.
  const ring = checked.locator("span[class*=rounded-full]").first();
  const dotPaint = await ring.evaluate((el) => getComputedStyle(el).backgroundImage);
  expect(dotPaint, "the checked dot is painted in the brand accent").toContain(accent);
  expect(dotPaint, "…and never in the faint hover grey").not.toContain(panel2);
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

// #389///the invisible-dot regression must never come back, and no state
// here may rest on a transform (a resting transform exempts an element from device-pixel snapping,
// and in Tailwind v4 `scale-*` and `transform-none` are separate properties, which is how a pin that
// only checked `transform` passed while the dot was invisible). Sincethe ring paints the dot
// itself, so "visible" means the gradient actually carries the accent — the geometry of that dot is
// pinned from real screenshots in control-alignment-389.spec.ts.
for (const dsf of [1, 1.25]) {
  test(`#389: the checked radio dot is really painted, and rests transform-free (dsf ${dsf})`, async ({ browser }) => {
    const page = await (await browser.newContext({ deviceScaleFactor: dsf })).newPage();
    await page.goto("/settings/account/editor");
    const choices = page.locator("[data-slot=radio-group-choice]");
    await choices.first().waitFor({ timeout: 10000 });
    const { accent } = await resolvedVars(page);
    const rings = await page.evaluate(() => {
      const out: { paint: string; scale: string; transform: string; state: string | null }[] = [];
      for (const choice of document.querySelectorAll("[data-slot=radio-group-choice]")) {
        const ring = choice.querySelector("span[class*=rounded-full]");
        if (!ring) continue;
        const cs = getComputedStyle(ring);
        out.push({ paint: cs.backgroundImage, scale: cs.scale, transform: cs.transform, state: choice.getAttribute("data-state") });
      }
      return out;
    });
    expect(rings.length).toBeGreaterThan(1);
    expect(rings.some((r) => r.state === "checked"), "one option is selected").toBe(true);
    for (const r of rings) {
      expect(r.scale, `a ring rests without a scale (got ${r.scale})`).toBe("none");
      expect(r.transform, `a ring rests without a transform (got ${r.transform})`).toBe("none");
      if (r.state === "checked") {
        expect(r.paint, "the checked ring paints a dot in the brand accent").toContain(accent);
      } else {
        expect(r.paint, "an unchecked ring paints no accent dot").not.toContain(accent);
      }
    }
  });
}
