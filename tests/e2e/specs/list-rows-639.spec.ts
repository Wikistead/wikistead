import { test, expect } from "@playwright/test";
import { openDemo, sleep } from "../helpers";

// #639 (user ruling, 2026-08-06): the source sweep says no screen WRITES a boxed row; this says the rows
// a reader actually sees behave. Three things the ruling asks for that only the real DOM can answer:
//
//   Scroll once the list grows, instead of showing an empty box by default — a short list is short, and only a
//   long one scrolls. A fixed height would satisfy a source check and still show an empty frame.
//   Rows in one list are the same height (#586's lesson, where built-in and custom rows differed).
//   The separator is a rule under each row and not under the last one.
//
// Both lists are SUPPLIED rather than taken from whatever the fixture happens to hold: these are the
// screens where a tenant may legitimately have none, and a spec that measures an empty list measures
// nothing. Only the GET is stubbed; nothing here writes.
const KEY = (i: number) => ({
  id: `k${i}`, name: `key ${i}`, scope: "read", prefix: `wks_${i}`,
  createdAt: "2026-01-01T00:00:00Z", lastUsedAt: null, expiresAt: null, ownerSub: "u1",
});
const HOOK = (i: number) => ({ id: `h${i}`, url: `https://example.test/hook/${i}`, active: true, events: ["page.published"] });

const LISTS = [
  { path: "/admin/api", box: "api-key-list", row: "api-key-item", url: "**/api/api-keys", body: () => [KEY(0), KEY(1), KEY(2)] },
  { path: "/admin/webhooks", box: "webhook-list", row: "webhook-item", url: "**/api/webhooks", body: () => ({ webhooks: [HOOK(0), HOOK(1), HOOK(2)], nextCursor: null }) },
] as const;

for (const l of LISTS) {
  test(`#639: ${l.box} is a list of ruled rows that grows with its content`, async ({ page }) => {
    test.setTimeout(90_000);
    await openDemo(page);
    await page.route(l.url, async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(l.body()) });
    });
    await page.goto(l.path);
    const box = page.getByTestId(l.box);
    await expect(box).toBeVisible({ timeout: 15_000 });
    await sleep(400);

    const m = await page.evaluate(({ boxId, rowId }) => {
      const box = document.querySelector<HTMLElement>(`[data-testid="${boxId}"]`)!;
      const rows = [...document.querySelectorAll<HTMLElement>(`[data-testid="${rowId}"]`)];
      const cs = (el: HTMLElement) => getComputedStyle(el);
      return {
        rows: rows.length,
        // a row is separated by a RULE, not by being its own box
        boxed: rows.filter((r) => parseFloat(cs(r).borderTopLeftRadius) > 0 && parseFloat(cs(r).borderTopWidth) > 0).length,
        ruled: rows.filter((r) => parseFloat(cs(r).borderBottomWidth) > 0).length,
        // "draws a rule", not "has a border": the last row keeps its border and paints it transparent, so
        // that it stays the same height as the rest — dropping the border made it 1px shorter, which is
        // the uneven list #586 was about. Either implementation passes; a visible trailing rule does not.
        lastRuled: rows.length
          ? parseFloat(cs(rows[rows.length - 1]!).borderBottomWidth) > 0
            && !/rgba\(.*, ?0\)$|transparent/.test(cs(rows[rows.length - 1]!).borderBottomColor)
          : null,
        heights: [...new Set(rows.map((r) => Math.round(r.getBoundingClientRect().height)))],
        // the box grows with the rows rather than reserving a frame
        boxHeight: Math.round(box.getBoundingClientRect().height),
        rowsHeight: rows.reduce((a, r) => a + r.getBoundingClientRect().height, 0),
        scrolls: box.scrollHeight > box.clientHeight + 1,
      };
    }, { boxId: l.box, rowId: l.row });

    expect(m.rows, "the fixture has rows to measure").toBeGreaterThan(0);
    expect(m.boxed, "no row draws itself as a box").toBe(0);
    expect(m.ruled, "every row but the last carries the separating rule").toBeGreaterThanOrEqual(m.rows - 1);
    expect(m.lastRuled, "…and the last does not — a trailing rule reads as a list that continues").toBe(false);
    expect(m.heights.length, `rows in one list are the same height (saw ${JSON.stringify(m.heights)})`).toBe(1);
    // "no default empty box": a short list does not reserve space it is not using
    expect(m.scrolls, "a list this short does not scroll").toBe(false);
    expect(m.boxHeight, `the box is its rows (${m.boxHeight}px around ${Math.round(m.rowsHeight)}px of rows)`)
      .toBeLessThan(m.rowsHeight + 24);
  });
}

test("#639: …and once there are many rows the box stops growing and scrolls", async ({ page }) => {
  test.setTimeout(90_000);
  await openDemo(page);
  // 60 keys, so the answer cannot come from whatever the fixture happens to hold
  await page.route("**/api/api-keys", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    await route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify(Array.from({ length: 60 }, (_, i) => KEY(i))),
    });
  });
  await page.goto("/admin/api");
  const box = page.getByTestId("api-key-list");
  await expect(box).toBeVisible({ timeout: 15_000 });
  await sleep(600);

  const m = await page.evaluate(() => {
    const box = document.querySelector<HTMLElement>('[data-testid="api-key-list"]')!;
    return {
      rows: document.querySelectorAll('[data-testid="api-key-item"]').length,
      boxHeight: Math.round(box.getBoundingClientRect().height),
      scrolls: box.scrollHeight > box.clientHeight + 1,
      docHeight: Math.round(document.documentElement.scrollHeight),
      viewport: window.innerHeight,
    };
  });

  expect(m.rows, "the stub actually filled the list").toBeGreaterThan(20);
  expect(m.scrolls, "a long list scrolls inside its own box").toBe(true);
  // and the PAGE does not grow with the list, which is what "stretches downward forever" meant
  expect(m.docHeight, `the page is ${m.docHeight}px tall with ${m.rows} rows in it`)
    .toBeLessThan(m.viewport * 2);
});
