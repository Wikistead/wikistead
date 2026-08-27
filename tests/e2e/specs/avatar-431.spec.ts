import { test, expect } from "@playwright/test";
import { openScratch, sleep } from "../helpers";
import postgres from "postgres";
import { E2E } from "../fixtures";

// #431 the SAME user must show the SAME initials on every surface. In god-mode the header /
// author chips fell back to the sub ("dev-user" → "DE") while member surfaces read the members
// display name. God-mode now resolves its canonical identity through the dev bearer (/auth/me — the
// same display_name source), so the header derives initials from the display name, never the sub.
// What the row holds right now, so a restore puts back what it took rather than a literal that can
// drift from the seed. Returns undefined only if the row is missing, which is a broken fixture and
// should not be papered over with a guessed name.
async function seededDisplayName(sql: ReturnType<typeof postgres>): Promise<string | null> {
  const [row] = await sql<{ display_name: string | null }[]>`
    SELECT display_name FROM members WHERE tenant_id = 'tenant_dev' AND sub = 'dev-user'`;
  if (!row) throw new Error("the seeded dev-user member row is missing — the shared fixture is broken");
  return row.display_name;
}

test("#431 god-mode header initials come from the canonical display name, not the sub", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  // The display name used to be set here through the self override (PATCH /me/settings). That route now
  // answers 403 — "your display name is managed by your identity provider" — so the precondition could no
  // longer be established and this pin sat red, testing a door that had been closed on purpose rather than
  // the property it exists for. The property is unchanged: initials come from the CANONICAL display name,
  // never from the sub. So the name is set where identity actually lives now (the members row, ADR-020),
  // exactly as the second test in this file already does.
  const sql = postgres(E2E.pgAdmin);
  // Read what is there before overwriting it, and put THAT back in the finally. Both restores here
  // used to write the literal 'dev-user' under the comment "restore the seed", and three writers
  // disagree about what the seed is: `infra/db/seed.ts` writes 'Dev User'; the e2e issuer emits
  // `name: sub` (oidc-issuer.ts), so the login upsert writes 'dev-user' over it on every sign-in
  // (session.ts, `display_name = EXCLUDED.display_name`); and this file asserted a third answer.
  // A literal cannot be right while that is unsettled — reading the row first is, whichever writer
  // won last. (The disagreement itself is a separate defect; a restore should not be the thing that
  // decides it.) Note `display_name_override` is a DIFFERENT column and is not touched here.
  const before = await seededDisplayName(sql);
  await sql`UPDATE members SET display_name = 'Canonical Name' WHERE sub = 'dev-user'`;
  try {
    await page.goto("/p/demo");
    await page.waitForSelector("[data-testid=user-menu]");
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForSelector("[data-testid=user-menu]");
    await expect
      .poll(async () => (await page.getByTestId("user-menu").innerText()).trim(), { timeout: 8000 })
      .toBe("CN"); // "Canonical Name" → CN; the sub fallback would read "DE" (dev-user)
  } finally {
    await sql`UPDATE members SET display_name = ${before} WHERE sub = 'dev-user'`;
    await sql.end();
  }
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
  // The condition: dev-user's BASE display_name differs from the sub while NO override exists, so a
  // sub-derived label ("DE") and a name-derived one ("DU") disagree. The e2e identity does NOT provide
  // it on its own — the issuer emits `name: sub`, so a sign-in leaves display_name equal to the sub and
  // the two labels agree by accident, which is the state that hid the defect. The write below is the
  // precondition, and it must stay: `infra/db/seed.ts` writes 'Dev User', but the next login overwrites
  // that, so neither the seed nor a clean row can be relied on here.
  const sql = postgres(E2E.pgAdmin);
  const before = await seededDisplayName(sql);
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
    await sql`UPDATE members SET display_name = ${before} WHERE sub = 'dev-user'`;
    await sql.end();
  }
});
