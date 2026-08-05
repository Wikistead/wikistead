import { test, expect } from "@playwright/test";
import { openDemo, sleep } from "../helpers";

// #623 (review ruling), first slice: the space's page list stops growing the screen.
//
// The acceptance is stated in rows, so it is measured in rows: five hundred of them, and the page must
// not be five hundred rows tall. The list is stubbed rather than authored — five hundred real pages is a
// slow way to ask a question about layout, and what is under test here is the SHAPE of the screen. The
// cursor and the search are measured against the real server in `space-access` (server) and by the
// requests this screen makes (below), which is the half a stub cannot fake.
const PAGE_SIZE = 50;

const overviewPage = (from: number, count: number, more: boolean) => ({
  items: Array.from({ length: count }, (_, i) => ({
    id: `p${from + i}`, title: `Page ${from + i}`, published: i % 2 === 0,
    hasUnpublishedChanges: false, grantCount: 0, linkCount: 0,
  })),
  nextCursor: more ? `${from + count}|p${from + count}` : null,
});

test("#623: five hundred pages do not make a five-hundred-row screen", async ({ page }) => {
  test.setTimeout(120_000);
  const asked: string[] = [];
  await page.route("**/api/spaces/*/pages-overview**", (route) => {
    const url = new URL(route.request().url());
    asked.push(url.search || "(none)");
    const cursor = url.searchParams.get("cursor");
    const from = cursor ? Number(cursor.split("|")[0]) : 0;
    return route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify(overviewPage(from, PAGE_SIZE, from + PAGE_SIZE < 500)),
    });
  });

  await openDemo(page);
  await page.goto("/spaces/demo_space/settings/pages");
  await expect(page.getByTestId("space-pages-scroller")).toBeVisible({ timeout: 15_000 });
  await sleep(600);

  // the first answer is ONE page of rows, not the space
  const firstCount = await page.getByTestId("space-page-row").count();
  expect(firstCount, `the screen drew ${firstCount} rows for the first request`).toBeLessThanOrEqual(PAGE_SIZE);

  // and the screen is the height of a box, not of the data
  const geom = await page.evaluate(() => ({
    box: Math.round(document.querySelector("[data-testid=space-pages-scroller]")!.getBoundingClientRect().height),
    doc: Math.round(document.documentElement.scrollHeight),
    win: window.innerHeight,
  }));
  expect(geom.box, `the list box grew to ${geom.box}px`).toBeLessThanOrEqual(600);
  expect(geom.doc, `the page is ${geom.doc}px tall in a ${geom.win}px window`).toBeLessThan(geom.win * 2);

  // reading to the bottom of the box asks for the next page — with a CURSOR, not an offset
  await page.getByTestId("space-pages-scroller").evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await sleep(1200);
  expect(asked.length, `the box asked again when it was read to the end :: ${JSON.stringify(asked)}`).toBeGreaterThan(1);
  expect(asked.some((s) => s.includes("cursor=")), `the follow-up carried a cursor :: ${JSON.stringify(asked)}`).toBe(true);
  expect(asked.some((s) => /offset=/i.test(s)), `an offset was used :: ${JSON.stringify(asked)}`).toBe(false);

  // …and the box still is not the height of the data after reading further
  const after = await page.evaluate(() =>
    Math.round(document.querySelector("[data-testid=space-pages-scroller]")!.getBoundingClientRect().height));
  expect(after, `the box grew to ${after}px after loading more`).toBeLessThanOrEqual(600);
});

test("#623: the filter asks the server, not the rows already fetched", async ({ page }) => {
  test.setTimeout(120_000);
  const asked: string[] = [];
  await page.route("**/api/spaces/*/pages-overview**", (route) => {
    const url = new URL(route.request().url());
    asked.push(url.search || "(none)");
    const q = url.searchParams.get("q") ?? "";
    // the stub answers as a server would: the match is made over everything, not over what was sent before
    const items = q
      ? [{ id: "deep", title: `Page 499 ${q}`, published: false, hasUnpublishedChanges: false, grantCount: 0, linkCount: 0 }]
      : overviewPage(0, PAGE_SIZE, true).items;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ items, nextCursor: null }) });
  });

  await openDemo(page);
  await page.goto("/spaces/demo_space/settings/pages");
  await expect(page.getByTestId("space-pages-filter")).toBeVisible({ timeout: 15_000 });
  await sleep(600);

  await page.getByTestId("space-pages-filter").fill("needle");
  await sleep(1200);
  expect(asked.some((s) => s.includes("q=needle")), `the filter reached the server :: ${JSON.stringify(asked)}`).toBe(true);
  // a row that was never in the first page is reachable through it — which is the whole point: filtering
  // on the client would have searched only the fifty rows already here
  await expect(page.getByTestId("space-page-row"), "the server's answer is what the screen shows").toHaveCount(1);
  await expect(page.getByText("Page 499 needle")).toBeVisible();
});
