import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { openDemo, sleep } from "../helpers";

// #652 the tenant turns the second-factor requirement on FROM THE PRODUCT, and it bites.
//
// The reject was not "the policy is wrong" — the endpoints and the interstitial were already measured.
// It was that no screen wrote the policy, so the only way to require a second factor was a PATCH by
// hand. This drives the switch in the real DOM and then asks the question that makes the switch worth
// having: after clicking it, does a password sign-in with no factor actually stop?
//
// The stance is READ back from the database only as a cross-check. The claim under test is behavioural
// the sibling spec (`factor-signin-real-652`) writes the stance directly and measures the sign-in; here
// the stance is written by a person clicking, and the sign-in is the witness that the click landed.
const TENANT = "tenant_dev";
const STAMP = Date.now().toString(36);
const ADMIN = "dev-user"; // the only admin in the e2e tenant, and who `openDemo` signs in as
const EMAIL = `fpolicy652-${STAMP}@e2e.test`;
const PASSWORD = "a real password for the 652 switch";

/** Playwright's own process is not started with the env files (only the apps it spawns are). */
const dbUrl = (() => {
  if (process.env.DATABASE_ADMIN_URL) return process.env.DATABASE_ADMIN_URL;
  for (const f of [".env.e2e.local", ".env.e2e"]) {
    try {
      const line = readFileSync(resolve(import.meta.dirname, "../../..", f), "utf8")
        .split("\n").find((l) => l.startsWith("DATABASE_ADMIN_URL="));
      if (line) return line.slice("DATABASE_ADMIN_URL=".length).trim();
    } catch { /* try the next file */ }
  }
  throw new Error("no DATABASE_ADMIN_URL for the e2e stack");
})();
const sql = postgres(dbUrl);

// Both cases write the SAME tenant-level state (the stance, and whether the admin holds a factor), so
// they cannot overlap: the first run interleaved them and the second case opened the screen against a
// tenant the first was still setting up. Serial rather than merged into one case, because "off-limits
// with nobody enrolled" is the state the product ships in and deserves to be readable on its own.
test.describe.configure({ mode: "serial" });

type Prefs = { second_factor_required: boolean; second_factor_kinds: string; local_login_enabled: boolean; sso_required: boolean };
let priorPrefs: Prefs | null = null;

const stanceInDb = async (): Promise<boolean> => {
  const [row] = await sql<{ v: boolean }[]>`
    SELECT second_factor_kinds <> 'off' AS v FROM tenant_login_prefs WHERE tenant_id = ${TENANT}`;
  // #676: the runtime reads the KINDS column now, so "is anything required" is derived from it. Reading
  // the old boolean would report a stance this build no longer enforces.
  return row?.v ?? false;
};

/**
 * Give the admin a confirmed factor, which is what `canEnable` counts.
 *
 * No TOTP secret row: nothing here presents a code, and `adminWithFactorCount` joins the header table
 * on `confirmed_at IS NOT NULL`. An UNCONFIRMED row would leave `canEnable` false — the distinction the
 * migration's comment exists for, and the one this file uses in both directions.
 */
const enrolAdmin = () => sql`
  INSERT INTO member_factors (id, tenant_id, member_sub, kind, label, confirmed_at)
  VALUES (${`f652-${STAMP}`}, ${TENANT}, ${ADMIN}, 'totp', 'switch spec', now())
  ON CONFLICT (id) DO UPDATE SET confirmed_at = now()`;
const unenrolAdmin = () => sql`DELETE FROM member_factors WHERE id = ${`f652-${STAMP}`}`;

test.beforeAll(async () => {
  const [pref] = await sql<Prefs[]>`
    SELECT second_factor_required, second_factor_kinds, local_login_enabled, sso_required
    FROM tenant_login_prefs WHERE tenant_id = ${TENANT}`;
  priorPrefs = pref ?? null;
  // start from OFF with the password door open: the switch has to be the thing that turns it on
  await sql`
    INSERT INTO tenant_login_prefs (tenant_id, second_factor_required, second_factor_kinds, local_login_enabled)
    VALUES (${TENANT}, FALSE, 'off', TRUE)
    ON CONFLICT (tenant_id) DO UPDATE
      SET second_factor_required = FALSE, second_factor_kinds = 'off', local_login_enabled = TRUE`;
});

test.afterAll(async () => {
  await unenrolAdmin().catch(() => {});
  // The seat outlives everything else — left behind it pushes the tenant past its cap and reddens
  // whatever measures the tenant's size next (the leak #638 and #655 both shipped once).
  const mine = sql`SELECT sub FROM members WHERE tenant_id = ${TENANT} AND email = ${EMAIL}`;
  await sql`DELETE FROM member_factors WHERE member_sub IN (${mine})`.catch(() => {});
  await sql`DELETE FROM local_credentials WHERE member_sub IN (${mine})`.catch(() => {});
  await sql`DELETE FROM invites WHERE tenant_id = ${TENANT} AND email = ${EMAIL}`.catch(() => {});
  await sql`DELETE FROM members WHERE tenant_id = ${TENANT} AND email = ${EMAIL}`.catch(() => {});
  if (priorPrefs) {
    await sql`
      UPDATE tenant_login_prefs
      SET second_factor_required = ${priorPrefs.second_factor_required},
          second_factor_kinds = ${priorPrefs.second_factor_kinds},
          local_login_enabled = ${priorPrefs.local_login_enabled},
          sso_required = ${priorPrefs.sso_required}
      WHERE tenant_id = ${TENANT}`.catch(() => {});
  } else {
    await sql`DELETE FROM tenant_login_prefs WHERE tenant_id = ${TENANT}`.catch(() => {});
  }
  await sql.end();
});

async function openSwitchboard(page: import("@playwright/test").Page, lang = "en") {
  await page.addInitScript((l) => { try { localStorage.setItem("wks.lang", l); } catch { /* private */ } }, lang);
  await openDemo(page);
  await page.goto("/admin/auth");
  await expect(page.getByTestId("sign-in-method-second-factor-required"),
    "the requirement has a row on the switchboard").toBeVisible({ timeout: 20_000 });
  await sleep(300);
}

test("#652: an admin turns the requirement on from the screen, and it bites", async ({ page, browser, request }) => {
  test.setTimeout(240_000);
  await enrolAdmin(); // otherwise the server refuses the ON, correctly (`admin_factor_required`)

  // ── a member the product made, with a password and no factor ────────────────────────────────────
  //
  // Through the invitation, not by hand: a row inserted straight into `members` has no FGA membership
  // and `establishMemberSession` refuses it, so a correct password comes back "invalid credentials"
  // (the sibling spec's note, measured there).
  const invite = await request.post("/api/members/invites", {
    data: { email: EMAIL, role: "member", kind: "local" }, // `kind` matters: the default is `oidc`, and
    headers: { authorization: "Bearer dev-token", "sec-fetch-site": "same-origin" }, // acceptance filters on local
  });
  expect(invite.ok(), `the invite was issued :: ${invite.status()} ${await invite.text()}`).toBe(true);
  const token = new URL((await invite.json() as { inviteUrl: string }).inviteUrl).searchParams.get("token")!;
  const accepted = await request.post("/api/auth/local/accept", {
    data: { token, password: PASSWORD },
    headers: { "sec-fetch-site": "same-origin" },
  });
  expect(accepted.ok(), `the invite was accepted :: ${accepted.status()} ${await accepted.text()}`).toBe(true);

  // ── the switch ──────────────────────────────────────────────────────────────────────────────────
  await openSwitchboard(page);
  const toggle = page.getByTestId("second-factor-required-toggle");
  await expect(toggle, "the switch is writable once an admin holds a factor").toBeEnabled();
  await expect(page.getByTestId("second-factor-no-admin"),
    "…and the blocking reason is gone with it").toHaveCount(0);
  expect(await stanceInDb(), "nothing is required before the click").toBe(false);

  // ON asks first: existing sessions without a factor become subject, which the row cannot say
  await toggle.click();
  const confirm = page.getByTestId("second-factor-required-confirm");
  await expect(confirm, "turning it ON warns before writing").toBeVisible({ timeout: 10_000 });
  expect(await stanceInDb(), "and writes nothing while the question is open").toBe(false);
  await confirm.click();

  await expect.poll(stanceInDb, { timeout: 20_000, message: "the click wrote the stance" }).toBe(true);
  await expect(page.getByTestId("second-factor-required-toggle"))
    .toHaveAttribute("aria-checked", "true", { timeout: 10_000 });

  // ── the witness: the requirement now stops a password sign-in with no factor ─────────────────────
  //
  // A fresh context, because the admin's session in `page` is not the one under test. This is the half
  // that makes the switch real: a screen that PATCHes and changes nothing would pass everything above.
  const ctx = await browser.newContext();
  const visitor = await ctx.newPage();
  await visitor.goto("/login/recovery"); // #605's screen renders the password form unconditionally
  await expect(visitor.getByTestId("login-local"), "the password form is on screen").toBeVisible({ timeout: 20_000 });
  await visitor.getByTestId("login-local-identifier").fill(EMAIL);
  await visitor.getByTestId("login-local-password").fill(PASSWORD);
  await visitor.getByTestId("login-local-submit").click();
  // …and specifically the ENROL branch: this member holds no factor, so "present the one you have"
  // would be the wrong step and would also pass a plain `login-factor-step` assertion.
  await expect(visitor.getByTestId("login-factor-step"),
    "a correct password now leads to the second step, not into the app").toBeVisible({ timeout: 20_000 });
  await expect(visitor.getByTestId("login-factor-enrol-start"),
    "…the one that offers enrolment, since they hold nothing yet").toBeVisible({ timeout: 10_000 });
  await ctx.close();

  // ── OFF asks too, and is never BLOCKED — the switch is not a one-way door (#674) ─────────────────
  //
  // #652 asked only on the way up, reasoning from the sign-out. Turning the requirement off lowers the
  // bar for the whole tenant and cannot be undone for whoever signs in meanwhile, so it asks as well;
  // asking is not refusing, and the tenant whose last enrolled admin left can still get out.
  await page.getByTestId("second-factor-required-toggle").click();
  const offConfirm = page.getByTestId("second-factor-required-confirm");
  await expect(offConfirm, "turning it OFF asks first").toBeVisible({ timeout: 10_000 });
  expect(await stanceInDb(), "…and writes nothing while the question is open").toBe(true);

  // #683: and the dialog does not head the question with its opposite. It used to open "Require
  // two-factor authentication" over a body ending "Stop requiring two-factor authentication?" — the
  // first line read said the reverse of what was being asked, which is what #674 put this confirmation
  // here to prevent. Measured on the RENDERED dialog rather than on the strings alone (that pin lives in
  // `stance-dialog-direction-683`): what a reader meets is the heading in the real box.
  const offHeading = (await offConfirm.evaluate((el) => {
    const box = el.closest('[role="dialog"], [role="alertdialog"]') ?? el.parentElement;
    return box?.querySelector("h1,h2,h3,[data-testid$=-title]")?.textContent ?? "";
  })).trim();
  expect(offHeading.length, "the confirmation has no heading to read").toBeGreaterThan(0);
  expect(offHeading, `the OFF dialog is headed as if it turned the requirement ON :: ${offHeading}`)
    .toMatch(/stop|やめ|解除|外す/i);

  // cancelling leaves the requirement standing — the half that makes the question real
  await page.keyboard.press("Escape");
  await expect(offConfirm).toBeHidden({ timeout: 10_000 });
  await sleep(1200);
  expect(await stanceInDb(), "a cancelled question changes nothing").toBe(true);

  await page.getByTestId("second-factor-required-toggle").click();
  await page.getByTestId("second-factor-required-confirm").click();
  await expect.poll(stanceInDb, { timeout: 20_000, message: "confirming turns it off" }).toBe(false);
});

test("#652: with no enrolled admin the switch is off-limits, and says why", async ({ page }) => {
  test.setTimeout(180_000);
  await unenrolAdmin(); // the state a tenant is in before anybody has set up a factor
  expect(await stanceInDb(), "and the requirement is off").toBe(false);

  await openSwitchboard(page);
  await expect(page.getByTestId("second-factor-required-toggle"),
    "nobody could satisfy the requirement, so it cannot be turned on").toBeDisabled();

  // Readable without hovering. A disabled switch with a hover-only explanation reads as broken, and
  // the fix here is one an admin can make in the next minute — so the row has to name it.
  const reason = page.getByTestId("second-factor-no-admin");
  await expect(reason, "the row says what is missing").toBeVisible();
  await expect(reason).toContainText(/enrol a second factor/i);
  // …and NOT the plan sentence: `entitled` and `canEnable` are different refusals, and sending an
  // admin to a pricing page when the fix is to enrol a factor is the confusion the reject named.
  await expect(page.getByTestId("second-factor-unentitled"), "this is not a billing refusal").toHaveCount(0);

  // the same row in Japanese — the copy is a pair, and a reason only English speakers can read is
  // half a fix (the gate checks the keys exist; this checks the row actually renders the ja one)
  await openSwitchboard(page, "ja");
  await expect(page.getByTestId("second-factor-no-admin")).toContainText("登録");
});
