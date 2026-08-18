import { test, expect } from "@playwright/test";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { sleep } from "../helpers";

// #650 / ADR-226: recovery codes, through the BROWSER against the REAL server.
//
// The server suite drives the routes and asks whether they are right; this asks the question the
// routes cannot answer — does a person who has lost their phone actually get back in, using only what
// the screens put in front of them? Every step here is a real click on a real element:
//
//   1. create a set from account settings (the re-authentication is asked for, and answered)
//   2. copy a code off the one-time display — the ONLY time it exists
//   3. sign out, sign in, meet the factor step with no way to answer it
//   4. take the "lost your device" door, spend the code, and land in the product
//   5. …and the account is genuinely RESET: the factor is gone and the code is refused a second time
//
// ⚠️ The codes are read from the DISPLAY, not from the database. Reading them from `member_recovery_codes`
// is impossible anyway (only the hash is there), and that is the point being verified: if the display
// were wrong, every other test in the repository would still pass and no member could ever use a code.
function totp(secretBase32: string, at = Date.now()): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0, value = 0;
  const bytes: number[] = [];
  for (const ch of secretBase32.replace(/[\s=]/g, "").toUpperCase()) {
    value = (value << 5) | alphabet.indexOf(ch);
    bits += 5;
    if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  const counter = Math.floor(at / 1000 / 30);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const mac = createHmac("sha1", Buffer.from(bytes)).update(buf).digest();
  const off = mac[mac.length - 1]! & 0x0f;
  const bin = ((mac[off]! & 0x7f) << 24) | (mac[off + 1]! << 16) | (mac[off + 2]! << 8) | mac[off + 3]!;
  return String(bin % 1_000_000).padStart(6, "0");
}

const TENANT = "tenant_dev";
const STAMP = Date.now().toString(36);
const EMAIL = `recovery-${STAMP}@e2e.test`;
const PASSWORD = "a real password for 650 e2e";
// The break-glass screen renders the password form unconditionally; /login hides it unless the tenant
// selected password sign-in. What is under test is the step AFTER the password.
const LOGIN = "/login/recovery";

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

type Prefs = { second_factor_required: boolean; second_factor_kinds: string; local_login_enabled: boolean; sso_required: boolean };
let priorPrefs: Prefs | null = null;
/** The tenant's plan before this file raised it — see `beforeAll`. */
let priorPlan: string | null = null;

const setPrefs = (secondFactor: boolean) => sql`
  INSERT INTO tenant_login_prefs (tenant_id, second_factor_required, second_factor_kinds, local_login_enabled, sso_required)
  VALUES (${TENANT}, ${secondFactor}, ${secondFactor ? "any" : "off"}, TRUE, FALSE)
  ON CONFLICT (tenant_id) DO UPDATE
    SET second_factor_required = ${secondFactor}, second_factor_kinds = ${secondFactor ? "any" : "off"},
        local_login_enabled = TRUE, sso_required = FALSE`;

test.beforeAll(async () => {
  const [pref] = await sql<Prefs[]>`
    SELECT second_factor_required, second_factor_kinds, local_login_enabled, sso_required
    FROM tenant_login_prefs WHERE tenant_id = ${TENANT}`;
  priorPrefs = pref ?? null;

  // ── the SEAT CAP, and why this file raises the plan for its own run ─────────────────────────────
  //
  // The fixture tenant is on `pro`, which is a ONE-SEAT plan (#691's ruling: Personal is a plan for one
  // person), and since #720 gave the entitlements resolver a composition point that cap is enforced for
  // real. So inviting the member this spec needs answers 402 `seat_limit` — measured, and it is not a
  // fact about this ticket: every spec here that invites somebody hits it.
  //
  // Raised HERE and restored in afterAll, the same shape this file already uses for the login prefs,
  // rather than by moving the shared fixture to `team`. That was measured too: `team` also switches on
  // SCIM, SAML, the audit log, analytics and custom roles, and ~30 specs in this directory assert
  // against surfaces those levers gate. Flipping a shared fixture to fix one spec is how a green run
  // starts meaning something different.
  //
  // ⚠️ AND THEN WAIT. `db/registry.ts` caches the tenant row for 30 seconds, so a plan written here is
  // NOT what the server sees if any earlier spec in the run touched this tenant inside that window —
  // measured: alone this spec is green, run after `factor-signin-real-652` it hits the same 402, because
  // the registry was still holding `pro`. A sleep is the honest price of mutating a cached fixture; the
  // sound fix is a tenant that already has the seats (#738), and this spec loses the wait the day it lands.
  const [t] = await sql<{ plan: string }[]>`SELECT plan FROM tenants WHERE id = ${TENANT}`;
  priorPlan = t?.plan ?? null;
  if (priorPlan !== "team") {
    await sql`UPDATE tenants SET plan = 'team' WHERE id = ${TENANT}`;
    await sleep(31_000); // the registry's 30s TTL, plus a second
  }
});

test.afterAll(async () => {
  // The SEAT is the litter that matters: left behind it pushes the tenant past its cap and reddens
  // whatever measures the tenant's size next.
  const mine = sql`SELECT sub FROM members WHERE tenant_id = ${TENANT} AND email = ${EMAIL}`;
  await sql`DELETE FROM member_recovery_codes WHERE member_sub IN (${mine})`.catch(() => {});
  await sql`DELETE FROM email_outbox WHERE member_sub IN (${mine})`.catch(() => {});
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
  }
  // Put the PLAN back. Leaving the tenant on `team` would quietly open SCIM, SAML, the audit log,
  // analytics and custom roles for every spec that runs after this one.
  if (priorPlan) await sql`UPDATE tenants SET plan = ${priorPlan} WHERE id = ${TENANT}`.catch(() => {});
  await sql.end();
});

/** A new member meets the onboarding dialog, and its `fixed inset-0 z-50` overlay covers every click. */
async function dismissOverlays(page: import("@playwright/test").Page) {
  const overlay = page.locator("div.fixed.inset-0.z-50").first();
  for (let i = 0; i < 3; i++) {
    if (!(await overlay.isVisible().catch(() => false))) {
      await sleep(600);
      if (!(await overlay.isVisible().catch(() => false))) return;
    }
    await page.keyboard.press("Escape");
    await sleep(500);
  }
  await expect(overlay, "nothing is left covering the page").toBeHidden({ timeout: 10_000 });
}

async function signInWithPassword(page: import("@playwright/test").Page) {
  await page.goto(LOGIN);
  await page.getByTestId("login-local-identifier").fill(EMAIL);
  await page.getByTestId("login-local-password").fill(PASSWORD);
  await page.getByTestId("login-local-submit").click();
}

test("#650: a lost device, a code from the drawer, and back in", async ({ page, request }) => {
  test.setTimeout(240_000);
  // What the recovery routes actually answered. KEPT rather than removed once it was green: the first
  // failure of this spec was a box that never appeared, and "the set appears" said nothing about why.
  // The answer was `GET /me/recovery-codes → 500` — migration 125 had not reached the e2e database,
  // which is a different database from dev's and from the server suite's. A failure here should name
  // the call that broke, not leave the next reader to find that out again.
  const calls: string[] = [];
  page.on("response", (r) => {
    if (r.url().includes("recovery")) calls.push(`${r.request().method()} ${new URL(r.url()).pathname} → ${r.status()}`);
  });

  // ── a member made the way the product makes one ─────────────────────────────────────────────────
  // Rows written by hand have no FGA membership, and a correct password then comes back "invalid
  // credentials" — so this goes through the invitation the way a real member arrives.
  await setPrefs(false);
  const invited = await request.post("/api/members/invites", {
    data: { email: EMAIL, role: "member", kind: "local" },
    headers: { authorization: "Bearer dev-token", "sec-fetch-site": "same-origin" },
  });
  expect(invited.ok(), `the invitation was created (${invited.status()}) ${await invited.text()}`).toBe(true);
  const inviteToken = new URL((await invited.json() as { inviteUrl: string }).inviteUrl).searchParams.get("token")!;
  const accepted = await request.post("/api/auth/local/accept", {
    data: { token: inviteToken, password: PASSWORD },
    headers: { "sec-fetch-site": "same-origin" },
  });
  expect(accepted.ok(), `they accepted and chose a password (${accepted.status()})`).toBe(true);

  await signInWithPassword(page);
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 20_000 });
  await dismissOverlays(page);

  // ── enrol an authenticator, so there is something to recover ────────────────────────────────────
  await page.goto("/settings/account/security");
  await expect(page.getByTestId("second-factor-panel")).toBeVisible({ timeout: 20_000 });
  await dismissOverlays(page);

  // Before any factor exists, the panel says WHY there is nothing to create rather than offering a
  // button that would be refused (ADR-226 §2's one precondition, drawn).
  await expect(page.getByTestId("recovery-needs-factor"), "nothing to recover yet").toBeVisible();
  await expect(page.getByTestId("recovery-mint")).toHaveCount(0);

  await page.getByTestId("factor-add").click();
  await expect(page.getByTestId("factor-enrolling")).toBeVisible({ timeout: 15_000 });
  const secret = (await page.getByTestId("factor-secret-value").innerText()).replace(/\s/g, "");
  await page.getByTestId("factor-confirm-code").fill(totp(secret));
  await page.getByTestId("factor-confirm").click();
  await expect(page.getByTestId("factor-enrolling"), "the enrolment took").toBeHidden({ timeout: 15_000 });

  // ── create the codes, proving it is really them ─────────────────────────────────────────────────
  await expect(page.getByTestId("recovery-mint"), "…and now there is").toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("recovery-status")).toBeVisible();
  await page.getByTestId("recovery-mint").click();

  // A session alone must not be enough — that is the whole re-authentication rule, and here it is a
  // form the reader has to fill rather than a promise in an ADR.
  await expect(page.getByTestId("recovery-reauth"), "it asks who this is").toBeVisible({ timeout: 10_000 });
  await page.getByTestId("recovery-reauth-password").fill(PASSWORD);
  await page.getByTestId("recovery-reauth-submit").click();

  await expect(page.getByTestId("recovery-minted"), `the set appears (recovery calls: ${JSON.stringify(calls)})`)
    .toBeVisible({ timeout: 20_000 });
  // ⚠️ Read off the SCREEN. This is the only place the plaintext ever exists, so a display that showed
  // the wrong thing would be invisible to every other test and fatal to every member.
  const shown = (await page.getByTestId("recovery-codes-value").innerText()).trim();
  const codes = shown.split(/\s*\n\s*/).map((c) => c.replace(/\s+/g, "")).filter(Boolean);
  expect(codes.length, `ten codes were displayed (saw: ${JSON.stringify(shown).slice(0, 200)})`).toBe(10);

  await page.getByTestId("recovery-done").click();
  await expect(page.getByTestId("recovery-status"), "…and afterwards, only a count").toContainText("10");
  await expect(page.getByTestId("recovery-codes-value"), "the codes are not shown again").toHaveCount(0);

  // ── the phone is gone: the stance is on and they cannot answer it ───────────────────────────────
  await setPrefs(true);
  await page.context().clearCookies();
  await signInWithPassword(page);

  const step = page.getByTestId("login-factor-step");
  await expect(step, "the second step appears").toBeVisible({ timeout: 20_000 });
  // The door offered nothing but a code box before this ticket. The link is the way out, and it only
  // appears because the sign-in response said this member holds a set.
  const open = page.getByTestId("login-recovery-open");
  await expect(open, "the way back is on the screen").toBeVisible({ timeout: 10_000 });
  await open.click();

  // The consequence is stated BEFORE the box, not after: somebody who reads it afterwards has already
  // pressed the button.
  await expect(page.getByTestId("login-recovery-warning")).toBeVisible();

  // A wrong code is refused by the SERVER, and the form stays to try again in.
  await page.getByTestId("login-recovery-code").fill("ZZZZ-ZZZZ-ZZZZ-ZZZZ");
  await page.getByTestId("login-recovery-submit").click();
  await expect(page.getByTestId("login-factor-error")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("login-recovery-form"), "still here").toBeVisible();

  // …and a real one gets them in.
  await page.getByTestId("login-recovery-code").fill(codes[0]!);
  await page.getByTestId("login-recovery-submit").click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 30_000 });

  // ── it was a RESET, not a shortcut ──────────────────────────────────────────────────────────────
  await dismissOverlays(page);
  await page.goto("/settings/account/security");
  await expect(page.getByTestId("second-factor-panel"), "signed in, not bounced").toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("factor-label"), "every factor is gone").toHaveCount(0);
  // The rest of the set went with it — nine live codes after a rescue is a credential nobody tracks.
  await expect(page.getByTestId("recovery-needs-factor"), "and there is nothing left to recover").toBeVisible();

  // The second use of the same code is refused, from a fresh door.
  await setPrefs(false);
  await page.context().clearCookies();
  await signInWithPassword(page);
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 20_000 });
  const spent = await sql<{ n: string }[]>`
    SELECT count(*) AS n FROM member_recovery_codes
    WHERE member_sub IN (SELECT sub FROM members WHERE tenant_id = ${TENANT} AND email = ${EMAIL})
      AND used_at IS NULL AND revoked_at IS NULL`;
  expect(Number(spent[0]!.n), "not one live code survived the rescue").toBe(0);
});
