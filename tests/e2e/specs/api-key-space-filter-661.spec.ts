import { test, expect } from "@playwright/test";
import { openDemo, sleep } from "../helpers";

// #661 (user, on the device): " UI ".
//
// Measured against a STUBBED `/spaces` of 40, and that is the whole reason this spec can say anything
// the dev fixture has one space, so a pin that opened the form as-is would watch a single checkbox and
// call the list bounded. The same trap emptied a #623 pin, which was written against a real tree, could
// not be turned red, and was discarded.
//
// Only the GET is stubbed. Nothing here writes.
const N = 40;
const SPACES = Array.from({ length: N }, (_, i) => ({
  id: `s661-${i}`,
  tenantId: "tenant_dev",
  name: i === 7 ? "Marketing" : `Space ${String(i).padStart(2, "0")}`,
  createdAt: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(),
  capability: "manage",
}));

async function openNarrow(page: import("@playwright/test").Page) {
  // The browser reaches the server through the web proxy, so the pattern is the PATH the page requests,
  // matched exactly — `**/api/spaces` would also swallow `/api/spaces/<id>/pages`, and stubbing the page
  // tree out from under the app is a different test with a different (broken) subject.
  await page.route((url) => url.pathname === "/api/spaces", (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    // #623 slice 12b: the route pages — `{ spaces, nextCursor }`. #705/#710: typing asks the SERVER
    // (`?q=`), so this stub must answer BOTH shapes or the filtered branch talks to the real tenant.
    // browse (no q) → one page, no cursor: this test is about the FORM in front of forty spaces.
    // search (q) → the matches, AND a cursor — i.e. the server still has more beyond this page,
    // which is exactly the state the "more matches" line exists to announce (#710 D
    // the old numeric hidden-count died with the roster; the signal is now the
    // server's hasMore, and a cursor is how the server says it).
    const q = new URL(route.request().url()).searchParams.get("q")?.trim() ?? "";
    const body = q
      ? { spaces: SPACES.filter((s) => s.name.toLowerCase().includes(q.toLowerCase())), nextCursor: "more-beyond-this-page" }
      : { spaces: SPACES, nextCursor: null };
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
  await openDemo(page);
  await page.goto("/admin/api");
  const toggle = page.getByTestId("api-key-narrow-toggle");
  await expect(toggle, "the create form is on screen").toBeVisible({ timeout: 20_000 });
  await toggle.click();
  await expect(page.getByTestId("api-key-space-list")).toBeVisible({ timeout: 10_000 });
  await sleep(300);
}

test("#661: forty spaces do not stretch the form, and the filter narrows them", async ({ page }) => {
  test.setTimeout(120_000);
  await openNarrow(page);

  const list = page.getByTestId("api-key-space-list");
  expect(await page.getByTestId("api-key-space-option").count(), "the stub arrived").toBe(N);

  // the box scrolls instead of growing — measured, because "it has a max height class" is a claim about
  // the stylesheet and this is a claim about the page
  const box = await list.evaluate((el) => ({
    h: el.getBoundingClientRect().height, scroll: el.scrollHeight, overflow: getComputedStyle(el).overflowY,
  }));
  expect(box.scroll, "forty rows really do overflow the box").toBeGreaterThan(box.h);
  expect(box.overflow, "…so the box must be the thing that scrolls").toMatch(/auto|scroll/);
  expect(box.h, "the form grew with the tenant").toBeLessThan(500);

  // Before typing, the whole (stubbed) roster fits: nothing is withheld, so nothing announces it.
  // Measuring the quiet side too is what keeps the next assertion from passing on a line that is
  // simply always rendered.
  await expect(page.getByTestId("api-key-space-more"), "nothing is hidden yet, so nothing says so").toHaveCount(0);

  // the filter narrows
  await page.getByTestId("api-key-space-filter").fill("Marketing");
  await sleep(250);
  expect(await page.getByTestId("api-key-space-option").count(), "the filter did nothing").toBe(1);
  // …and the form SAYS that what you see is not everything that matched. #710 D replaced the numeric
  // hidden-count with this line: a count taken from the first page would silently under-state (the
  // client no longer holds the roster), so the honest signal is the server's own "there is more".
  // The pin is the READER'S side of that — a narrowed list must never read as the complete answer.
  await expect(page.getByTestId("api-key-space-more"), "…and says the list is not the whole answer").toBeVisible();
});

test("#661: a space you ticked does not vanish when you keep typing", async ({ page }) => {
  test.setTimeout(120_000);
  await openNarrow(page);

  // tick one, then filter to something it cannot match
  await page.getByTestId("api-key-space-s661-0").check();
  await page.getByTestId("api-key-space-filter").fill("Marketing");
  await sleep(250);

  await expect(page.getByTestId("api-key-space-s661-0"),
    "the ticked space was filtered out of the form that is about to submit it").toBeVisible();
  await expect(page.getByTestId("api-key-space-s661-0")).toBeChecked();
  await expect(page.getByTestId("api-key-space-s661-7"), "…and the match is still there").toBeVisible();
});

test("#661: the filter and the list are reachable from the keyboard alone", async ({ page }) => {
  test.setTimeout(120_000);
  await openNarrow(page);

  const filter = page.getByTestId("api-key-space-filter");
  await filter.focus();
  await filter.type("Marketing", { delay: 20 });
  await sleep(250);
  // Tab from the filter must land on a checkbox in the narrowed list — no pointer anywhere.
  await page.keyboard.press("Tab");
  const landed = await page.evaluate(() => document.activeElement?.getAttribute("data-testid") ?? "");
  expect(landed, `Tab from the filter reached ${landed || "nothing"}`).toMatch(/^api-key-space-/);
  await page.keyboard.press("Space");
  await sleep(150);
  expect(await page.getByTestId("api-key-space-s661-7").isChecked(), "Space ticked the focused option")
    .toBe(true);
});
