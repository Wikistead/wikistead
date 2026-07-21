import { test, expect } from "@playwright/test";
import { openScratch, sleep } from "../helpers";
import postgres from "postgres";
import { E2E } from "../fixtures";

// #431 the SAME user must show the SAME initials on every surface. In god-mode the header /
// author chips fell back to the sub ("dev-user" → "DE") while member surfaces read the members
// display name. God-mode now resolves its canonical identity through the dev bearer (/auth/me — the
// same display_name source), so the header derives initials from the display name, never the sub.
test("#431 god-mode header initials come from the canonical display name, not the sub", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await page.goto("/p/demo");
  await page.waitForSelector("[data-testid=user-menu]");
  // guarantee a display name distinct from the sub (the ADR-020 self override — same store the
  // members surfaces read), then reload so the session resolve picks it up
  await page.evaluate(async () => {
    await fetch("/api/me/settings", {
      method: "PATCH",
      headers: { authorization: "Bearer dev-token", "content-type": "application/json" },
      body: JSON.stringify({ displayNameOverride: "Canonical Name" }),
    });
  });
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector("[data-testid=user-menu]");
  await expect
    .poll(async () => (await page.getByTestId("user-menu").innerText()).trim(), { timeout: 8000 })
    .toBe("CN"); // "Canonical Name" → CN; the sub fallback would read "DE" (dev-user)
  // cleanup: drop the override so other specs see the seed identity
  await page.evaluate(async () => {
    await fetch("/api/me/settings", {
      method: "PATCH",
      headers: { authorization: "Bearer dev-token", "content-type": "application/json" },
      body: JSON.stringify({ displayNameOverride: null }),
    });
  });
});

// #431 the surface the earlier pass never pinned. The header was fixed to read the canonical
// display name, but the created/updated meta resolves each author through the shared identity hook —
// which answers only for CUSTOMIZED members (ADR-150, a user-ratified rule that keeps the endpoint
// from becoming a membership oracle). An un-customized member therefore fell back to the sub-derived
// label, so the SAME person read "DU" in the header and "DE" on their own page's meta. The hook now
// resolves the caller's OWN sub from the session, so every surface agrees without telling anyone
// anything new about anybody else.
test("#431 the created/updated meta avatar matches the header for the same (un-customized) user", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  // Reproduce the reported condition, which the e2e seed alone cannot: dev-user's BASE display_name
  // must differ from the sub while NO override exists. (In the seed both are "dev-user", so header
  // and meta agreed on "DE" by accident and the defect was invisible; on the real instance the base
  // name is "Dev User" → header "DU" vs meta "DE".) The override path is deliberately NOT used — that
  // one always resolved; the un-customized member is the case that broke.
  const sql = postgres(E2E.pgAdmin);
  await sql`UPDATE members SET display_name = 'Dev User' WHERE sub = 'dev-user'`;
  try {
  // a page AUTHORED BY dev-user (the seed demo page predates the created/updated columns, so it has
  // no byline to compare) and viewed as dev-user: header and meta describe the same person.
  await openScratch(page, `avatar431-${Date.now().toString(36)}`);
  await page.waitForSelector("[data-testid=user-menu]");
  await page.waitForSelector("[data-testid=page-meta]", { timeout: 8000 });

  const headerAvatar = page.getByTestId("user-avatar");
  const header = (await headerAvatar.innerText()).trim();
  const metaAvatars = page.getByTestId("page-meta").getByTestId("comment-avatar");
  await expect(metaAvatars.first()).toBeVisible({ timeout: 8000 });
  const metaInitials = (await metaAvatars.first().innerText()).trim();

  // the reported defect was header "DU" vs meta "DE" — the same user reading two ways
  expect(metaInitials, `meta initials must match the header (header=${header})`).toBe(header);

  // colour was already unified by the sub seed — assert it stays that way, so a future
  // name-source change cannot silently split the two surfaces again.
  const headerColor = await headerAvatar.evaluate((el) => getComputedStyle(el).backgroundColor);
  const metaColor = await metaAvatars.first().evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(metaColor, "sub-seeded colour is shared").toBe(headerColor);
  // the defect shape, stated positively: a sub-derived label would read "DE" here
  expect(metaInitials, "resolved from the display name, not the sub").not.toBe("DE");
  } finally {
    await sql`UPDATE members SET display_name = 'dev-user' WHERE sub = 'dev-user'`; // restore the seed
    await sql.end();
  }
});
