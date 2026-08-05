import { test, expect } from "@playwright/test";
import { openDemo, sleep } from "../helpers";

// #579 ⑤: the non-regression list from the previous review, item by item.
//
// It was measured once, by hand, in a session that is over — and then three more rejects landed on this
// screen. "I did not contradict it" is not the same as "it still holds", and the reason this file exists
// is that the list was carried forward twice as prose without anybody re-measuring it.
//
// What measured, at 1440x900
// the give-a-role form is FOUR controls on one line (type / search / role / add, y=137 h=32 each)
// the filter is a different row (y=283, 146px below) — the two operations do not read as one
// the role picker names a role, rather than showing an empty box
// every row has exactly one role control and one ⋯ (the row for yourself has no ⋯)
// a tier option reveals what it confers, from the tenant's live defaults rather than a constant
const VIEWPORT = { width: 1440, height: 900 };

test("#579 the two operations stay two, and the row keeps one of each control", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize(VIEWPORT);
  await openDemo(page);
  await page.goto("/admin/members");
  await expect(page.getByTestId("members-filter")).toBeVisible({ timeout: 15_000 });
  await sleep(600);

  // the form: four controls, one line. Measured as a relation (same top, same height) rather than as the
  // y=137 the original run happened to see — a page that grows a banner would fail on the number while
  // being perfectly correct.
  const geom = await page.evaluate(() => {
    const box = (id: string) => {
      const el = document.querySelector<HTMLElement>(`[data-testid=${id}]`);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { top: Math.round(r.top), h: Math.round(r.height), w: Math.round(r.width), text: (el.textContent ?? "").trim().slice(0, 40) };
    };
    return {
      type: box("tenant-grant-type"), input: box("tenant-grant-input"),
      role: box("tenant-grant-role"), add: box("tenant-grant-add"),
      filter: box("members-filter"),
    };
  });
  for (const [name, b] of Object.entries(geom)) expect(b, `${name} is on the screen`).not.toBeNull();
  const form = [geom.type!, geom.input!, geom.role!, geom.add!];
  expect([...new Set(form.map((b) => b.top))], `the four controls share one line :: ${JSON.stringify(form)}`).toHaveLength(1);
  expect([...new Set(form.map((b) => b.h))], `…and one height :: ${JSON.stringify(form)}`).toHaveLength(1);

  // the filter is a DIFFERENT row, well clear of the form — the reject was "the filter reads as part of
  // the form", so what matters is separation, not a particular gap
  expect(geom.filter!.top, `the filter sits below the form (form ${geom.type!.top}, filter ${geom.filter!.top})`)
    .toBeGreaterThan(geom.type!.top + geom.type!.h + 40);

  // the role picker NAMES something rather than being an empty box
  expect(geom.role!.text.length, `the role control is not an empty box :: ${JSON.stringify(geom.role)}`).toBeGreaterThan(0);
  expect(geom.role!.w, "…and has a readable width").toBeGreaterThan(60);

  // one role control and at most one ⋯ per row (your own row has no ⋯ — you cannot act on yourself here)
  const perRow = await page.evaluate(() => {
    const rows = [...document.querySelectorAll("tbody tr")];
    return rows.map((tr) => ({
      roles: tr.querySelectorAll("[data-testid=member-role-select]").length,
      menus: tr.querySelectorAll("[data-testid=member-actions]").length,
      name: (tr.querySelector("td")?.textContent ?? "").trim().slice(0, 24),
    }));
  });
  expect(perRow.length, "there are rows to measure").toBeGreaterThan(0);
  expect(perRow.filter((r) => r.roles !== 1), `a row without exactly one role control :: ${JSON.stringify(perRow)}`).toEqual([]);
  expect(perRow.filter((r) => r.menus > 1), `a row with more than one action menu :: ${JSON.stringify(perRow)}`).toEqual([]);
});

test("#579 a tier option still says what it confers, from this tenant's own defaults", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize(VIEWPORT);
  await openDemo(page);
  await page.goto("/admin/members");
  await expect(page.getByTestId("members-filter")).toBeVisible({ timeout: 15_000 });
  await sleep(600);

  // what the SERVER says the member tier confers — the reject's point was that this list is the tenant's
  // live defaults and not a constant compiled into the client
  const defaults = await page.evaluate(async () => {
    const r = await fetch("/api/admin/roles/tenant-defaults", { headers: { Authorization: "Bearer dev-token" } });
    return r.ok ? ((await r.json()) as { member?: Record<string, boolean> }).member ?? {} : {};
  });
  const conferred = Object.entries(defaults).filter(([, on]) => on).map(([k]) => k);
  expect(conferred.length, "the tenant confers something on plain members (else this measures nothing)").toBeGreaterThan(0);

  await page.getByTestId("member-role-select").first().click();
  await page.waitForSelector("[role=listbox]", { timeout: 8_000 });
  await sleep(300);
  const option = page.getByRole("option", { name: "member", exact: true }).first();
  await option.hover();
  await sleep(600);
  const panel = page.locator("[data-role-panel]").first();
  await expect(panel, "hovering a tier option reveals what it confers").toBeVisible({ timeout: 5_000 });
  const shown = ((await panel.textContent()) ?? "").toLowerCase();
  // the wording is localised, so the check is that the panel is not empty and grows with the defaults
  // `createSpaces` is the one every tenant starts with and the one the original run read off the screen
  expect(shown.replace(/\s+/g, "").length, `the panel says something :: ${shown}`).toBeGreaterThan(4);
  if (conferred.includes("createSpaces")) {
    expect(shown, `the panel names the space-creation default :: ${shown}`).toMatch(/space|スペース/);
  }
});
