import { test, expect } from "@playwright/test";
import { openScratch, sleep } from "../helpers";

// #623 slice 6: the Related rail holds three sections, and the first two are lists that grow with the
// page's neighbourhood — up to 200 backlinks and 20 groups of 12. Unboxed they pushed §Related and
// §Local graph thousands of pixels below the fold, so a well-connected page's panel read as if it had
// one section: the other two were still there, just unreachable without scrolling past everything.
//
// Measured in a real browser because the claim is about layout, and stubbed at the network because the
// defect needs a neighbourhood no fixture should create — 200 published pages linking to one. Only the
// two GETs are stubbed; nothing is written (the #537 discipline).
const BACKLINKS = Array.from({ length: 200 }, (_, i) => ({
  id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
  title: `A page that links here number ${i}`,
}));
const RELATED = {
  groups: Array.from({ length: 20 }, (_, g) => ({
    intermediate: { id: `10000000-0000-4000-8000-${String(g).padStart(12, "0")}`, title: `Shared link ${g}` },
    pages: Array.from({ length: 12 }, (_, i) => ({
      id: `20000000-0000-4000-8000-${String(g * 12 + i).padStart(12, "0")}`,
      title: `Related page ${g}-${i}`,
    })),
  })),
  truncated: false,
};

test("#623: a crowded neighbourhood does not push the rest of the rail off the panel", async ({ page }) => {
  test.setTimeout(180_000);
  await page.route(/\/pages\/[^/]+\/backlinks/, (r) => r.fulfill({ json: BACKLINKS }));
  await page.route(/\/pages\/[^/]+\/related$/, (r) => r.fulfill({ json: RELATED }));

  await openScratch(page, `rel623-${Date.now()}`);
  await sleep(400);
  await page.getByTestId("page-overflow-trigger").click();
  await page.getByTestId("related-toggle").click();
  await expect(page.getByTestId("related-panel")).toBeVisible({ timeout: 10_000 });
  await sleep(600);

  // the fixture really is crowded — without this the rest measures an empty panel and passes vacuously
  const box = page.getByTestId("related-groups");
  const crowd = await box.evaluate((el) => ({
    scroll: el.scrollHeight,
    client: el.clientHeight,
    rows: el.querySelectorAll("li").length,
  }));
  expect(crowd.rows, "the related section really drew its 240 rows").toBe(240);
  expect(crowd.scroll, "…and they overflow, so the box has something to do").toBeGreaterThan(crowd.client);
  expect(crowd.client, "the section is boxed, not as tall as its contents").toBeLessThan(600);

  // …and the section BELOW it is still reachable: the distance from the top of the panel's content to
  // the local-graph toggle is a screenful or two, not the height of two hundred rows.
  const reach = await page.evaluate(() => {
    const panel = document.querySelector('[data-testid="related-panel"]')!;
    const toggle = document.querySelector('[data-testid="local-graph-toggle"]')!;
    return toggle.getBoundingClientRect().top - panel.getBoundingClientRect().top + panel.scrollTop;
  });
  expect(reach, `the local graph sits ${Math.round(reach)}px into the panel`).toBeLessThan(1200);
});
