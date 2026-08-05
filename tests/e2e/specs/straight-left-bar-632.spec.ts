import { test, expect } from "@playwright/test";
import { openDemo, openScratch, enterEdit, sleep } from "../helpers";

// #632 (user ruling, 2026-08-05): " AI ".
//
// A coloured bar down the left of a box with rounded corners curves inward at both ends. Six places had
// grown the same idiom. The assertion is about the SHAPE, not about those six: any element with a
// rounded left edge AND a coloured left bar is the defect, so a seventh written tomorrow fails the day
// it lands. Naming today's six would pass while the pattern spread.
//
// "Coloured" matters — a plain 1px border in the border token is not a bar, it is a box, and boxes are
// allowed to be round. What the ruling objects to is the accent stripe.
async function curvedBars(page: import("@playwright/test").Page) {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("*")]
      .map((el) => {
        const cs = getComputedStyle(el);
        const px = (v: string) => parseFloat(v) || 0;
        // A left bar is either a thick left border or an inset shadow cast to the right. The computed
        // form puts the keyword LAST — `rgb(9, 105, 218) 2px 0px 0px 0px inset` — so the first offset is
        // read positionally rather than by looking for "inset <n>". Measured: matching the authored
        // order found nothing, and restoring the very bar this ticket removed left the pin green.
        const borderBar = px(cs.borderLeftWidth) >= 2;
        // …and `box-shadow` is a LIST. Tailwind's ring/shadow utilities stack four transparent zeroes in
        // front of the real one, so reading the first offset in the whole string measured a shadow that
        // is not there. Split, then look only at the segment that says `inset`. Measured: without the
        // split, restoring the exact bar this ticket removes left the pin green.
        const shadowBar = cs.boxShadow.split(/,(?![^(]*\))/).some((part) => {
          if (!part.includes("inset")) return false;
          const offsets = part.match(/(-?[\d.]+)px/g) ?? [];
          return px(offsets[0] ?? "0") >= 2;
        });
        if (!borderBar && !shadowBar) return null;
        const roundedLeft = px(cs.borderTopLeftRadius) > 0 || px(cs.borderBottomLeftRadius) > 0;
        if (!roundedLeft) return null;
        const box = el.getBoundingClientRect();
        if (box.width === 0 || box.height === 0) return null;
        return {
          tag: el.tagName.toLowerCase(),
          testid: el.dataset.testid ?? "",
          cls: el.className.toString().slice(0, 60),
          borderLeft: cs.borderLeftWidth + " " + cs.borderLeftColor,
          shadow: cs.boxShadow.slice(0, 60),
          radius: `${cs.borderTopLeftRadius}/${cs.borderBottomLeftRadius}`,
        };
      })
      .filter(Boolean));
}

for (const [name, path] of [["settings", "/admin/members"], ["login", "/"], ["space settings", "/spaces/demo_space/settings/members"]] as const) {
  test(`#632: no curved left bar on ${name}`, async ({ page }) => {
    await openDemo(page);
    await page.goto(path);
    await sleep(1200);
    const found = await curvedBars(page);
    expect(found, `a coloured left bar against a rounded left edge: ${JSON.stringify(found)}`).toEqual([]);
  });
}

test("#632: a callout keeps its bar, its tint and its icon — only the corners changed", async ({ page }) => {
  await openScratch(page, "callout-632");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(":::warning\nheads up\n:::\n\nbelow\n");
  await sleep(700);
  await page.getByTestId("displaymode-wysiwyg").click();
  await sleep(700);

  const panel = page.locator("[data-pane=preview] .cm-lp-callout-panel").first();
  await expect(panel, "a callout rendered").toBeVisible({ timeout: 5_000 });
  const seen = await panel.evaluate((el) => {
    const cs = getComputedStyle(el);
    return {
      borderLeftWidth: cs.borderLeftWidth,
      borderLeftColor: cs.borderLeftColor,
      background: cs.backgroundColor,
      topLeft: cs.borderTopLeftRadius,
      topRight: cs.borderTopRightRadius,
      // the icon sits before the text and the ruling said not to move it
      paddingLeft: cs.paddingLeft,
      display: cs.display,
    };
  });
  // the bar is still 3px and still coloured — the ruling said keep it
  expect(parseFloat(seen.borderLeftWidth), "the bar is still there").toBeGreaterThanOrEqual(2);
  expect(seen.borderLeftColor, "and still carries the type's colour").not.toBe("rgba(0, 0, 0, 0)");
  expect(seen.background, "the tint is untouched").not.toBe("rgba(0, 0, 0, 0)");
  // the icon's layout is untouched: the panel is still the flex row it was, with its own padding
  expect(seen.display, "the icon still sits in the same flex row").toBe("flex");
  expect(parseFloat(seen.paddingLeft), "and the padding that positions it is unchanged").toBeGreaterThan(0);
  // …and the LEFT corners are square while the right ones are not
  expect(parseFloat(seen.topLeft), "left corner is square").toBe(0);
  expect(parseFloat(seen.topRight), "right corner keeps its radius").toBeGreaterThan(0);
});
