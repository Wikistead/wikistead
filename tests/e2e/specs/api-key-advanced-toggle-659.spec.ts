import { test, expect } from "@playwright/test";
import { openDemo, sleep } from "../helpers";

// #659 (user ruling, 2026-08-06): just call it "Advanced settings" or the like.
//
// The toggle was labelled "narrow what it reaches" when closed and "close the narrowing" when open.
// Two problems in one control:
//
//   1. It renamed itself. A control whose label changes with its state asks the reader to learn two
//      words for one thing, and the second word describes the ACTION rather than what is behind it.
//   2. "What it reaches" names half of what is inside. The panel holds spaces AND capabilities,
//      and a capability is not a destination — it is what may be done once there.
//
// Measured with the panel OPEN and CLOSED and the two labels compared, because each reads fine on its
// own; the defect only exists across the two states. The chevron is asserted separately, by ROTATION
// rather than by text — a pin that only read the label would stay green with the icon deleted, and the
// label is now the same in both states, so the icon is the only thing left saying which way it goes.
test("#659: the toggle keeps its name, and the chevron says which way it is", async ({ page }) => {
  test.setTimeout(120_000);
  await openDemo(page);
  await page.goto("/admin/api");

  const toggle = page.getByTestId("api-key-narrow-toggle");
  await expect(toggle, "the create form is on screen").toBeVisible({ timeout: 20_000 });
  const panel = page.getByTestId("api-key-narrow");
  await expect(panel, "…and starts collapsed").toBeHidden();

  const closedLabel = (await toggle.innerText()).trim();
  const closedChevron = await chevronAngle(toggle);

  await toggle.click();
  await expect(panel, "it opened").toBeVisible({ timeout: 10_000 });
  await sleep(400); // past the rotation
  const openLabel = (await toggle.innerText()).trim();
  const openChevron = await chevronAngle(toggle);

  expect(openLabel, `the control renames itself: "${closedLabel}" closed vs "${openLabel}" open`).toBe(closedLabel);
  expect(closedLabel.length, "and it still says something").toBeGreaterThan(0);

  // …and since the words no longer distinguish the states, the icon must
  expect(closedChevron, "there is a chevron to measure").not.toBeNull();
  expect(Math.abs((openChevron ?? 0) - (closedChevron ?? 0)), "the chevron turns when it opens")
    .toBeGreaterThan(45);

  // the panel still holds both of the things the old name only half-described.
  //
  // ⚠️ `api-key-cap-list` until #667: the six borrowed role verbs were replaced by the resource-type x
  // read/write table, so this asserted an element the product no longer renders and the spec was red on
  // master. Repointed rather than deleted — what it measures is that the toggle reveals BOTH halves of
  // the narrowing, and that is still true; only the name of the second half changed.
  await expect(page.getByTestId("api-key-space-list"), "spaces").toBeVisible();
  await expect(page.getByTestId("api-key-perm-list"), "permissions").toBeVisible();

  await toggle.click();
  await expect(panel, "and it closes again").toBeHidden({ timeout: 10_000 });
});

/**
 * The chevron's rotation in degrees, from the computed style — never from a class name.
 *
 * BOTH properties, because Tailwind v4 sets the standalone `rotate` property for `rotate-90`, not
 * `transform`. Measured: with the class correctly applied, `getComputedStyle(svg).transform` reads
 * `"none"` in both states, so a transform-only reading called a working chevron broken. A class-name
 * assertion would have been worse in the other direction — green on a class the build never emitted.
 */
async function chevronAngle(toggle: import("@playwright/test").Locator): Promise<number | null> {
  return toggle.evaluate((el) => {
    const svg = el.querySelector("svg");
    if (!svg) return null;
    const cs = getComputedStyle(svg);
    const standalone = parseFloat(cs.rotate); // "none" → NaN, "90deg" → 90
    if (Number.isFinite(standalone)) return Math.round(standalone);
    if (cs.transform === "none") return 0;
    const m = new DOMMatrixReadOnly(cs.transform);
    return Math.round((Math.atan2(m.b, m.a) * 180) / Math.PI);
  });
}
