import { test, expect } from "@playwright/test";
import { openDemo, sleep } from "../helpers";

// #661 the space picker's rows carry the space's own icon.
//
// Measured in a browser because the claim is about what is DRAWN — a source check can say the component
// is used, and this says an image element with the space's own URL ends up on the row, and an initials
// chip where no image was uploaded (which is `SpaceIcon`'s existing behaviour, not a second rule).
//
// The other half is the regression: taller rows must not make the BOX taller. It has a maximum height
// and scrolls; icons should cost visible rows inside it, never page length. That is the property #623
// and #639 established and the one this change is most likely to break.
const N = 40;
const WITH_IMAGE = "s-07";
const ICON_PATH = "/space-icon-661.svg";
const ICON_SVG = "<svg xmlns='http://www.w3.org/2000/svg' width='8' height='8'><rect width='8' height='8' fill='#c33'/></svg>";
const SPACES = Array.from({ length: N }, (_, i) => {
  const id = `s-${String(i).padStart(2, "0")}`;
  return {
    id,
    tenantId: "tenant_dev",
    name: i === 7 ? "Marketing" : `Space ${String(i).padStart(2, "0")}`,
    createdAt: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(),
    capability: "manage",
    // One space has an uploaded icon; the rest fall back to initials. A fixture where every space
    // looked the same could not tell "the image is used" from "everything is a letter".
    //
    // A relative path, and its BYTES are stubbed below. Two things make this the only shape that
    // works: `useSpaces` runs the value through `assetUrl`, which prefixes the API base (so a data URI
    // arrives mangled), and `Avatar` falls back to initials on a load ERROR (so a 404 would report "no
    // image" about a build that renders images correctly).
    iconImageUrl: id === WITH_IMAGE ? ICON_PATH : null,
  };
});

async function openNarrow(page: import("@playwright/test").Page) {
  // Path matched exactly: `**/api/spaces` would also swallow `/api/spaces/<id>/pages` and stub the page
  // tree out from under the app (A's note on the neighbouring spec).
  await page.route((url) => url.pathname === `/api${ICON_PATH}`, (route) =>
    route.fulfill({ status: 200, contentType: "image/svg+xml", body: ICON_SVG }));
  // #719: the stub answered a BARE ARRAY, which stopped being the endpoint's shape on `1ccc1953`
  // (#623 slice 12b, the day after this spec was written): the route pages now, and the client reads
  // `page.spaces`. A bare array made that `undefined ?? []` — an EMPTY list — so every assertion below
  // was measuring a form with no rows at all. The shape is `{ spaces, nextCursor }`; the row-count
  // assertion in the test body is what keeps this honest if the shape moves again.
  await page.route((url) => url.pathname === "/api/spaces", (route) =>
    route.request().method() === "GET"
      ? route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ spaces: SPACES, nextCursor: null }) })
      : route.fallback());
  await openDemo(page);
  await page.goto("/admin/api");
  const toggle = page.getByTestId("api-key-narrow-toggle");
  await expect(toggle, "the create form is on screen").toBeVisible({ timeout: 20_000 });
  await toggle.click();
  await expect(page.getByTestId("api-key-space-list")).toBeVisible({ timeout: 10_000 });
  // #719: the list ELEMENT being visible says nothing about rows — an empty box is visible too, and
  // that is exactly how this spec sat green-shaped but vacuous for eleven days. Wait for the rows the
  // stub promised before any measurement runs.
  await expect(page.getByTestId("api-key-space-option").first(), "the stub's rows are drawn").toBeVisible({ timeout: 10_000 });
  await sleep(300);
}

test("#661: every row wears its space's icon, and the box still does not grow", async ({ page }) => {
  test.setTimeout(120_000);
  await openNarrow(page);

  const rows = page.getByTestId("api-key-space-option");
  expect(await rows.count(), "the stub arrived").toBe(N);

  // 1. every row draws something for the space — no row is left as a bare checkbox and a name
  const drawn = await rows.evaluateAll((els) =>
    els.map((el) => {
      const img = el.querySelector("img");
      if (img) return `img:${img.getAttribute("src") ?? ""}`;
      // the initials fallback: a chip carrying the first letters, painted (not transparent)
      const chip = [...el.querySelectorAll("span, div")].find((n) => {
        const cs = getComputedStyle(n as Element);
        return cs.backgroundColor !== "rgba(0, 0, 0, 0)" && (n.textContent ?? "").trim().length > 0
          && (n.textContent ?? "").trim().length <= 3;
      });
      return chip ? `initials:${(chip.textContent ?? "").trim()}` : "none";
    }),
  );
  expect(drawn.filter((d) => d === "none"), `every row draws a space :: ${drawn.slice(0, 4).join(" | ")}`).toEqual([]);

  // 2. the one with an uploaded image uses THAT image, not a letter
  const withImage = page.locator('[data-testid="api-key-space-option"]', { hasText: "Marketing" });
  await expect(withImage.locator("img"), "the configured icon is the one shown").toHaveCount(1);
  // …and the rest are initials, or the assertion above would pass on a build that drew images for all
  expect(drawn.filter((d) => d.startsWith("initials:")).length, "the others fall back to initials").toBeGreaterThan(N - 5);

  // 3. the regression: rows got taller, the box did not
  const box = await page.getByTestId("api-key-space-list").evaluate((el) => ({
    client: (el as HTMLElement).clientHeight,
    scroll: (el as HTMLElement).scrollHeight,
    overflow: getComputedStyle(el as Element).overflowY,
  }));
  expect(box.scroll, "forty rows overflow the box").toBeGreaterThan(box.client);
  expect(box.overflow, "…and it scrolls inside itself").toMatch(/auto|scroll/);
  expect(box.client, `the box keeps its ceiling :: ${JSON.stringify(box)}`).toBeLessThan(500);

  // 4. and the invariant this picker exists for still holds with icons in the way
  await page.getByTestId(`api-key-space-${WITH_IMAGE}`).check();
  await page.getByTestId("api-key-space-filter").fill("Space 33");
  await sleep(250);
  await expect(
    page.getByTestId(`api-key-space-${WITH_IMAGE}`),
    "a ticked space survives a filter that excludes it",
  ).toBeVisible();
});
