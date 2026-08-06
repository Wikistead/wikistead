import { test, expect } from "@playwright/test";
import { openDemo, sleep, API } from "../helpers";

// #644 ruling 2 / ADR-219 §10a: the administrator reset, from the console.
//
// The reset itself is measured against the REAL endpoint (server suite: `admin-factor-reset-644`).
// What only a browser can answer is whether an admin can find it, whether it is offered to the right
// rows, and whether the one refusal that exists reaches the screen as a sentence rather than as
// "Action failed" — the defect #596 and #606 are about, and the one #614 was rejected for.
//
// GET /members is stubbed, the #537 pattern: the dev tenant holds one real member and this needs four
// rows differing only in whether they hold a factor. Every write stays real.
const MEMBERS = {
  members: [
    { sub: "dev-user", email: "a@x.test", display_name: "Admin Themselves", picture_url: null, role: "admin", groups: null, created_at: "2026-01-01T00:00:00Z", identity_source: "oidc", has_password: false, has_factor: true, deactivated_at: null },
    { sub: "m-with", email: "b@x.test", display_name: "Holds A Factor", picture_url: null, role: "member", groups: null, created_at: "2026-01-02T00:00:00Z", identity_source: "oidc", has_password: true, has_factor: true, deactivated_at: null },
    { sub: "m-without", email: "c@x.test", display_name: "Holds Nothing", picture_url: null, role: "member", groups: null, created_at: "2026-01-03T00:00:00Z", identity_source: "oidc", has_password: true, has_factor: false, deactivated_at: null },
    { sub: "m-legacy", email: "d@x.test", display_name: "Older Response", picture_url: null, role: "member", groups: null, created_at: "2026-01-04T00:00:00Z", identity_source: "oidc", has_password: true, deactivated_at: null },
  ],
};

async function openMembers(page: import("@playwright/test").Page) {
  await page.route((url) => url.pathname === "/api/members", (route) =>
    route.request().method() === "GET"
      ? route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(MEMBERS) })
      : route.fallback());
  await openDemo(page);
  await page.goto("/admin/members");
  await expect(page.getByText("Holds A Factor")).toBeVisible({ timeout: 20_000 });
  await sleep(300);
}

const row = (page: import("@playwright/test").Page, name: string) => page.locator("tr", { hasText: name });

/**
 * Open one row's menu and answer what it contains.
 *
 * Scoped to the OPEN menu rather than to the row, because Radix renders the content in a portal at the
 * end of the document: the items are not inside the `tr` that owns them, and a page-wide `getByTestId`
 * sees every menu that is still mounted at once. Both mistakes were made here in turn — the first
 * matched two copies, the second matched none.
 */
async function menuOf(page: import("@playwright/test").Page, name: string) {
  await row(page, name).getByTestId("member-actions-trigger").click();
  const open = page.locator('[data-testid="member-actions"][data-state="open"]');
  await expect(open, `${name}: the menu opened at all`).toBeVisible({ timeout: 10_000 });
  return open;
}

/** …and shut it, waited for, so the next open is the only one on screen. */
async function closeMenu(page: import("@playwright/test").Page) {
  await page.keyboard.press("Escape");
  await expect(page.locator('[data-testid="member-actions"][data-state="open"]')).toHaveCount(0, { timeout: 10_000 });
}

test("#644: the reset is offered to somebody who holds a factor, and withheld from somebody who does not", async ({ page }) => {
  test.setTimeout(120_000);
  await openMembers(page);

  await expect((await menuOf(page, "Holds A Factor")).getByTestId("member-reset-factors"),
    "an admin cannot find the way to help them").toBeVisible();
  await closeMenu(page);

  // Withheld from a member with none. The reset SUCCEEDS on them — it deletes nothing and answers 200 —
  // so an always-offered item would report having helped somebody who is still locked out for another
  // reason, and the admin would stop looking. Worse than a button that fails.
  await expect((await menuOf(page, "Holds Nothing")).getByTestId("member-reset-factors")).toHaveCount(0);
  await closeMenu(page);

  // …and from a row served by a response that predates the field. Absent must read as "no", not as
  // "unknown, so offer it anyway": during a rolling deploy every row looks like this one.
  await expect((await menuOf(page, "Older Response")).getByTestId("member-reset-factors")).toHaveCount(0);
});

test("#644: it asks first, and says what the member will have to do next", async ({ page }) => {
  test.setTimeout(120_000);
  await openMembers(page);

  let sent: string | null = null;
  await page.route((url) => /\/api\/members\/[^/]+\/factors$/.test(url.pathname), async (route) => {
    if (route.request().method() !== "DELETE") return route.fallback();
    sent = route.request().url();
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ removed: 2 }) });
  });

  await (await menuOf(page, "Holds A Factor")).getByTestId("member-reset-factors").click();

  // Confirmed like every other consequential item (#504) — and the sentence has to carry the
  // consequence, because the admin reading it is usually on the phone with the person it affects.
  const dialog = page.getByRole("dialog");
  await expect(dialog, "the reset ran with no confirmation").toBeVisible({ timeout: 10_000 });
  const asked = await dialog.innerText();
  expect(asked, "the confirmation does not name who it is about").toContain("Holds A Factor");
  expect(asked.toLowerCase(), "…nor say that they must enrol again").toMatch(/sign in|set one up|again/);
  expect(sent, "the request went out before the admin agreed").toBeNull();

  await dialog.getByRole("button", { name: /reset|confirm|ok|yes/i }).first().click();
  await expect.poll(() => sent, { timeout: 15_000 }).not.toBeNull();
  expect(sent!, "…and it addressed the member whose row was open").toContain("m-with");
});

test("#644: aiming it at yourself is refused in words, not as \"Action failed\"", async ({ page }) => {
  test.setTimeout(120_000);
  await openMembers(page);

  // The server's refusal, verbatim in shape: your own factor proves itself first (#660 / ADR-219 §8).
  // Stubbed rather than provoked because provoking it needs the admin to hold a factor in the dev
  // tenant; what is under test is the SCREEN's reading of the code, which the real route also sends
  // (pinned in `admin-factor-reset-644`).
  await page.route((url) => /\/api\/members\/[^/]+\/factors$/.test(url.pathname), (route) =>
    route.request().method() === "DELETE"
      ? route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "no", code: "reset_self" }) })
      : route.fallback());

  await (await menuOf(page, "Admin Themselves")).getByTestId("member-reset-factors").click();
  await page.getByRole("dialog").getByRole("button", { name: /reset|confirm|ok|yes/i }).first().click();

  // A named reason, not the catch-all. Asserted on what was SAID: matching only "not Action failed"
  // would pass on a screen that said nothing at all.
  await expect.poll(async () => (await page.locator("[data-sonner-toast], [role=status]").allInnerTexts()).join(" | "),
    { timeout: 20_000, intervals: [500] }).toMatch(/account settings/i);
  const said = (await page.locator("[data-sonner-toast], [role=status]").allInnerTexts()).join(" | ");
  expect(said, "the refusal was folded into the catch-all").not.toMatch(/Action failed/i);
});

test("#644: the endpoint is admin-gated at the server, not merely hidden from the menu", async ({ page }) => {
  test.setTimeout(120_000);
  // #613's lesson, and the reason it is a lesson: the console withholding an item says nothing about
  // who may call the route. Asked from the page's own origin WITHOUT a principal.
  await openDemo(page);
  const status = await page.evaluate(async (api) => {
    const res = await fetch(`${api}/members/m-with/factors`, { method: "DELETE" });
    return res.status;
  }, API);
  expect(status, "an unauthenticated caller could clear somebody's second factors").toBeGreaterThanOrEqual(400);
});
