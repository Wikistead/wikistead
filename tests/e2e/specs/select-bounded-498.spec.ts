import { test, expect } from "@playwright/test";
import { sleep } from "../helpers";

// #498: the DS Select must open a BOUNDED popper below its trigger. Radix's "item-aligned" mode (the old
// default) overlays the trigger and EXPANDS as you wheel-scroll, so a long option list grew until it
// filled the viewport. Pinned on a long list in a short window (the member role picker): the popup is
// anchored under the trigger, never taller than the viewport, and wheel-scrolling scrolls INSIDE it
// without growing the box.

test("#498: the select dropdown stays bounded and scrolls inside, instead of growing to the viewport", async ({ browser }) => {
  // A SHORT window, and a picker that is already long.
  //
  // This used to create thirty spaces per run to guarantee a long list, then drive `assign-role` /
  // `assign-space` on /admin/roles. Those controls are gone — #514/#579 moved granting to the Members
  // page and the space settings — so the click waited out the sixty-second timeout, the run never
  // reached its cleanup, and the thirty spaces stayed. Measured: thirty of this tenant's thirty-two
  // spaces were this one test's litter.
  //
  // The subject does not need a huge list, only a list taller than the window. Shrinking the window
  // does that without adding anything to a tenant every session shares.
  const page = await (await browser.newContext({ viewport: { width: 1000, height: 400 } })).newPage();
  await page.goto("/admin/members");
  await expect(page.getByTestId("members-filter")).toBeVisible({ timeout: 10_000 });
  await sleep(600);

  // a PERSON's row — since #579 folded groups into this table, the first row can be a group, and the
  // subject here is an ordinary long picker rather than any particular principal's vocabulary
  const trigger = page.locator("tr:not([data-testid='member-row-group'])")
    .locator("[data-testid=member-role-select]").first();
  await expect(trigger).toBeEnabled({ timeout: 8000 });
  await trigger.click();

  const viewport = page.viewportSize()!;
  const trigBox = (await trigger.boundingBox())!;

  const content = page.locator("[data-slot=select-content]");
  await expect(content).toBeVisible({ timeout: 8000 });
  const before = (await content.boundingBox())!;

  // bounded: inside the viewport, and anchored to a SIDE of the trigger (popper — below, or flipped above
  // when there is no room below), never OVERLAYING it the way item-aligned does
  expect(before.height, "popup no taller than the viewport").toBeLessThanOrEqual(viewport.height + 1);
  const below = before.y >= trigBox.y + trigBox.height - 2;
  const above = before.y + before.height <= trigBox.y + 2;
  expect(below || above, `popup sits beside the trigger, not over it (trigger ${trigBox.y}-${trigBox.y + trigBox.height}, popup ${before.y}-${before.y + before.height})`).toBe(true);

  // wheel-scrolling scrolls INSIDE the popup and the box stays BOUNDED. (Exact height equality is not
  // asserted: once the inner list bottoms out, scroll chaining moves the page and popper legitimately
  // re-measures its available height — bounded and non-overlaying is the invariant, growing past the
  // viewport was the bug.)
  await content.hover();
  for (let i = 0; i < 3; i++) { await page.mouse.wheel(0, 160); await sleep(80); }
  const after = (await content.boundingBox())!;
  expect(after.height, `still bounded after scrolling (was ${before.height}, now ${after.height})`).toBeLessThanOrEqual(viewport.height + 1);
  // and it actually scrolled content (the viewport inside moved) — the list is long enough to need it
  const scrolled = await content.evaluate((el) => {
    const vp = el.querySelector("[data-radix-select-viewport]") as HTMLElement | null;
    return vp ? vp.scrollTop : -1;
  });
  expect(scrolled, "the list scrolled inside the bounded popup").toBeGreaterThan(0);
});
