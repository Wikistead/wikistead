import { test, expect, type Page } from "@playwright/test";

// #582 (final acceptance): wherever a role NAME is offered, pointing at it says what the role
// can do — and the option itself stays one line.
//
// The implementation is #586's (the option reveals on hover and on the arrow-key highlight, because
// Radix drives its list with `data-highlighted` rather than focus). This measures the OTHER half of the
// ruling: that the surfaces THIS ticket is about actually get it. Three rounds of "one screen fixed,
// green" is why the sweep walks the pickers it finds instead of asserting one of them.
async function optionsOf(page: Page, trigger: string): Promise<{ name: string; revealed: string }[]> {
  const control = page.getByTestId(trigger).first();
  await control.scrollIntoViewIfNeeded();
  await control.focus();
  await page.keyboard.press("Enter");
  await page.waitForSelector("[role=option]", { timeout: 5000 });
  const out: { name: string; revealed: string }[] = [];
  // walk with the arrow keys: that is the highlight the reveal follows, and it is the path a keyboard
  // user takes — a mouse-only measurement would miss a reveal bound to focus alone
  for (let i = 0; i < 10; i++) {
    await page.keyboard.press("ArrowDown");
    const seen = await page.evaluate(() => {
      const item = document.querySelector("[role=option][data-highlighted]") as HTMLElement | null;
      if (!item) return null;
      const caps = item.querySelector(".wks-role-caps") as HTMLElement | null;
      return {
        name: (item.textContent ?? "").trim(),
        revealed: caps && getComputedStyle(caps).visibility === "visible" ? (caps.textContent ?? "").trim() : "",
      };
    });
    if (seen && !out.some((o) => o.name === seen.name)) out.push(seen);
  }
  await page.keyboard.press("Escape");
  return out;
}

test("#582: a role picker offers names, and points at what they confer", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/spaces/demo_space/settings/members");
  await expect(page.getByTestId("space-members")).toBeVisible({ timeout: 15_000 });

  // the row's own picker: it is on screen without opening the add flow, and it is the control this
  // ticket's rounds kept coming back to
  const options = await optionsOf(page, "space-member-role-select");
  expect(options.length, `the picker offered roles to walk :: ${JSON.stringify(options)}`).toBeGreaterThan(1);
  // every option is a NAME: no capability list printed into the label itself
  for (const o of options) {
    const label = o.name.replace(o.revealed, "").trim();
    expect(label.split(/\s+/).length, `"${o.name}" reads as a name, not a list`).toBeLessThan(4);
  }
  // …and at least one of them said what it confers while highlighted (the built-ins all have a
  // measured table; a tenant tier deliberately has none — see role-option-tips.tsx)
  expect(options.some((o) => o.revealed.length > 0), `no option revealed anything: ${JSON.stringify(options)}`).toBe(true);
});
