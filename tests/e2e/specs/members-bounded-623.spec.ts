import { test, expect } from "@playwright/test";
import { openDemo, sleep } from "../helpers";

// #623 (review ruling), slice 2: the members screen stops growing with the tenant.
//
// This is the motivating case of the whole ticket — "does the page stretch forever as members are
// added?" — and it is the harder of the two, because people, invites and groups share one table (#579).
//
// Stubbed at 500 rows: what is under test is the SHAPE of the screen, and authoring five hundred members
// is a slow way to ask about layout. The cursor and the query are measured by what the screen ASKS for,
// which a stub cannot fake on the client's behalf.
const PAGE_SIZE = 50;

const members = (from: number, count: number) => Array.from({ length: count }, (_, i) => ({
  sub: `m${from + i}`, email: `m${from + i}@x.test`, display_name: `Member ${from + i}`,
  picture_url: null, role: "member", groups: null, created_at: new Date(2026, 0, 1, 0, 0, from + i).toISOString(),
  identity_source: "oidc", deactivated_at: null, deactivation_reason: null, has_password: false,
}));

test("#623: five hundred members do not make a five-hundred-row screen", async ({ page }) => {
  test.setTimeout(120_000);
  const asked: string[] = [];
  await page.route("**/api/members**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/invites")) return route.fulfill({ status: 200, contentType: "application/json", body: '{"invites":[]}' });
    asked.push(url.search || "(none)");
    const cursor = url.searchParams.get("cursor");
    const from = cursor ? Number(cursor.split("|")[1]?.replace("m", "") ?? 0) + 1 : 0;
    const more = from + PAGE_SIZE < 500;
    const page1 = members(from, PAGE_SIZE);
    return route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({
        members: page1,
        nextCursor: more ? `${page1[page1.length - 1]!.created_at}|${page1[page1.length - 1]!.sub}` : null,
      }),
    });
  });

  await openDemo(page);
  await page.goto("/admin/members");
  await expect(page.getByTestId("members-scroller")).toBeVisible({ timeout: 15_000 });
  await sleep(700);

  // one page of rows, not the tenant
  const rows = await page.locator("[data-testid=member-row-group]").count();
  expect(rows, `the screen drew ${rows} rows for the first request`).toBeLessThanOrEqual(PAGE_SIZE + 5);

  // the screen is the height of a box, not of the data
  const geom = await page.evaluate(() => ({
    box: Math.round(document.querySelector("[data-testid=members-scroller]")!.getBoundingClientRect().height),
    doc: Math.round(document.documentElement.scrollHeight),
    win: window.innerHeight,
  }));
  expect(geom.box, `the list box grew to ${geom.box}px`).toBeLessThanOrEqual(600);
  expect(geom.doc, `the page is ${geom.doc}px tall in a ${geom.win}px window`).toBeLessThan(geom.win * 2);

  // reading to the end asks for the next page, with a CURSOR
  await page.getByTestId("members-scroller").evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await sleep(1200);
  expect(asked.length, `the box asked again :: ${JSON.stringify(asked)}`).toBeGreaterThan(1);
  expect(asked.some((s) => s.includes("cursor=")), `with a cursor :: ${JSON.stringify(asked)}`).toBe(true);
  expect(asked.some((s) => /offset=/i.test(s)), `and never an offset :: ${JSON.stringify(asked)}`).toBe(false);
});

test("#623: the members filter asks the server", async ({ page }) => {
  test.setTimeout(120_000);
  const asked: string[] = [];
  await page.route("**/api/members**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/invites")) return route.fulfill({ status: 200, contentType: "application/json", body: '{"invites":[]}' });
    asked.push(url.search || "(none)");
    const q = url.searchParams.get("q") ?? "";
    // answered the way a server would: over EVERYTHING, not over what was sent before
    const body = q
      ? { members: [{ ...members(499, 1)[0]!, display_name: `Member 499 ${q}` }], nextCursor: null }
      : { members: members(0, PAGE_SIZE), nextCursor: "x|m49" };
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });

  await openDemo(page);
  await page.goto("/admin/members");
  await expect(page.getByTestId("members-filter")).toBeVisible({ timeout: 15_000 });
  await sleep(700);

  await page.getByTestId("members-filter").fill("needle");
  await sleep(1200);
  expect(asked.some((s) => s.includes("q=needle")), `the filter reached the server :: ${JSON.stringify(asked)}`).toBe(true);
  // a member who was never in the first page is reachable through it — which is the point: filtering on
  // the client would have searched only the fifty rows already here
  await expect(page.getByText("Member 499 needle")).toBeVisible({ timeout: 5_000 });
});
