import { test, expect } from "@playwright/test";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { sleep } from "../helpers";

// #652 / #653: the whole second-factor sign-in, through the BROWSER against the REAL server.
//
// The other interstitial spec stubs the endpoints and asks what the screen does with the two answers;
// the server suite drives the endpoints and asks whether they are right. This is the seam between them,
// and it is the question I had sent to a person: does a code computed the way an authenticator computes
// it actually get somebody in, from the sign-in screen? Everything but the physical phone is
// measurable, so measuring it is what the discipline asks.
//
// The TOTP is recomputed here rather than imported from the server package: verifying a code with the
// function that produced it verifies neither of them.
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
const EMAIL = `factor-real-${STAMP}@e2e.test`;
const PASSWORD = "a real password for 652 e2e";
// The break-glass screen (#605) renders the password form unconditionally; /login hides it unless the
// tenant selected password sign-in. What is under test is the step AFTER the password.
const RECOVERY = "/login/recovery";

/**
 * The tenant's STANCE is the only thing this spec writes directly — it has no API of its own yet.
 * Everything else goes through the product's own doors.
 *
 * The URL is read from `.env.e2e.local` because Playwright's own process is not started with those env
 * files (only the app processes it spawns are), so `process.env` has nothing here.
 */
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
/** Every address this file seats, so afterAll can take the SEATS back — they outlive everything else. */
const strays: string[] = [];

/** Set the stance, keeping the password door open. */
const setPrefs = (secondFactor: boolean) => sql`
  INSERT INTO tenant_login_prefs (tenant_id, second_factor_required, second_factor_kinds, local_login_enabled, sso_required)
  VALUES (${TENANT}, ${secondFactor}, ${secondFactor ? "any" : "off"}, TRUE, FALSE)
  ON CONFLICT (tenant_id) DO UPDATE
    SET second_factor_required = ${secondFactor}, second_factor_kinds = ${secondFactor ? "any" : "off"},
        local_login_enabled = TRUE, sso_required = FALSE`;
// #676: the stance is WHICH kinds now (migration 120), and the runtime reads that column — writing only
// the boolean left the tenant reading `off` while this file believed it had turned the policy on, and
// every case failed at the step that expects to be asked for a factor. `any` is what this fixture always
// meant: a factor is required and either kind will do.

test.beforeAll(async () => {
  const [pref] = await sql<Prefs[]>`
    SELECT second_factor_required, second_factor_kinds, local_login_enabled, sso_required
    FROM tenant_login_prefs WHERE tenant_id = ${TENANT}`;
  priorPrefs = pref ?? null;
});

test.afterAll(async () => {
  // The sub is minted by the acceptance, so this file's litter is found by its ADDRESS. The SEAT is the
  // one that matters: left behind it pushes the tenant past its cap and reddens whatever measures the
  // tenant's size next.
  for (const addr of [EMAIL, ...strays]) {
    const mine = sql`SELECT sub FROM members WHERE tenant_id = ${TENANT} AND email = ${addr}`;
    await sql`DELETE FROM member_factors WHERE member_sub IN (${mine})`.catch(() => {});
    await sql`DELETE FROM local_credentials WHERE member_sub IN (${mine})`.catch(() => {});
    await sql`DELETE FROM invites WHERE tenant_id = ${TENANT} AND email = ${addr}`.catch(() => {});
    await sql`DELETE FROM members WHERE tenant_id = ${TENANT} AND email = ${addr}`.catch(() => {});
  }
  // Put the tenant back exactly as it was: forcing the password door open, or leaving the stance on,
  // changes what every other spec in this run measures.
  if (priorPrefs) {
    await sql`
      UPDATE tenant_login_prefs
      SET second_factor_required = ${priorPrefs.second_factor_required},
          second_factor_kinds = ${priorPrefs.second_factor_kinds},
          local_login_enabled = ${priorPrefs.local_login_enabled},
          sso_required = ${priorPrefs.sso_required}
      WHERE tenant_id = ${TENANT}`.catch(() => {});
  }
  await sql.end();
});

/**
 * Get any modal overlay out of the way.
 *
 * A member who has just joined meets the onboarding dialog, and it is the OVERLAY that matters here —
 * `fixed inset-0 z-50` sits over the whole page, so every click after it waits for a timeout with no
 * hint as to why (measured: three minutes on a button that was visible, enabled and perfectly still).
 * The dialog may also arrive a moment after the navigation, so this waits for it rather than sampling
 * once, and then checks the OVERLAY is gone rather than the dialog — that is the thing in the way.
 */
async function dismissOverlays(page: import("@playwright/test").Page) {
  const overlay = page.locator("div.fixed.inset-0.z-50").first();
  for (let i = 0; i < 3; i++) {
    if (!(await overlay.isVisible().catch(() => false))) {
      await sleep(600); // it can arrive just after the navigation settles
      if (!(await overlay.isVisible().catch(() => false))) return;
    }
    await page.keyboard.press("Escape");
    await sleep(500);
  }
  await expect(overlay, "nothing is left covering the page").toBeHidden({ timeout: 10_000 });
}

test("#652: password, then a real code, and you are in", async ({ page, request }) => {
  test.setTimeout(180_000);

  // ── a member made the way the product makes one ─────────────────────────────────────────────────
  //
  // NOT rows written by hand: a member inserted straight into the table has no FGA membership, and
  // `establishMemberSession` refuses it — a correct password comes back "invalid credentials".
  //
  // `kind: "local"` is required. An invitation defaults to `oidc` (invites.ts:140) and the acceptance
  // filters on `kind = 'local'`, so an ordinary invite is refused here as a dead link — measured, and
  // it looks exactly like a bad token.
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
  expect(accepted.ok(), `they accepted and chose a password (${accepted.status()}) ${await accepted.text()}`).toBe(true);

  // ── with the policy OFF, the password alone is enough ───────────────────────────────────────────
  await page.goto(RECOVERY);
  await page.getByTestId("login-local-identifier").fill(EMAIL);
  await page.getByTestId("login-local-password").fill(PASSWORD);
  await page.getByTestId("login-local-submit").click();
  await expect(page.getByTestId("login-factor-step"), "nothing else is asked").toHaveCount(0, { timeout: 10_000 });
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 20_000 });

  // ── enrol from the settings screen ──────────────────────────────────────────────────────────────
  // A member who has just joined meets the onboarding dialog, and its overlay covers the page — the
  // click on "add" waited three minutes behind `fixed inset-0 z-50 bg-black/50` before this was
  // measured. Dismissing it is part of being a new member, not a workaround.
  await dismissOverlays(page);

  await page.goto("/settings/account/security");
  await expect(page.getByTestId("second-factor-panel")).toBeVisible({ timeout: 20_000 });
  await dismissOverlays(page);
  await page.getByTestId("factor-label-input").fill("e2e real");
  await page.getByTestId("factor-add").click();
  await expect(page.getByTestId("factor-enrolling")).toBeVisible({ timeout: 15_000 });
  const secret = (await page.getByTestId("factor-secret-value").innerText()).replace(/\s/g, "");
  await page.getByTestId("factor-confirm-code").fill(totp(secret));
  await page.getByTestId("factor-confirm").click();
  await expect(page.getByTestId("factor-enrolling"), "the enrolment took").toBeHidden({ timeout: 15_000 });

  await setPrefs(true);

  // ── sign in again: the password is no longer enough ─────────────────────────────────────────────
  await page.context().clearCookies();
  await page.goto(RECOVERY);
  await page.getByTestId("login-local-identifier").fill(EMAIL);
  await page.getByTestId("login-local-password").fill(PASSWORD);
  await page.getByTestId("login-local-submit").click();

  const step = page.getByTestId("login-factor-step");
  await expect(step, "the second step appears").toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("login-factor-enrol-start"), "…asking for the one they hold").toHaveCount(0);

  // a wrong code is refused BY THE SERVER, and the box stays to try again in
  await page.getByTestId("login-factor-code").fill("000000");
  await page.getByTestId("login-factor-submit").click();
  await expect(page.getByTestId("login-factor-error")).toBeVisible({ timeout: 15_000 });
  await expect(step, "still here").toBeVisible();

  // …and a code computed the way an authenticator computes it gets them in. A step ahead of the one
  // that confirmed the enrolment, since that counter is spent.
  await sleep(500);
  await page.getByTestId("login-factor-code").fill(totp(secret, Date.now() + 30_000));
  await page.getByTestId("login-factor-submit").click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 20_000 });

  // and the session is a real one: a member-only screen answers
  await page.goto("/settings/account/security");
  await expect(page.getByTestId("second-factor-panel"), "signed in, not bounced").toBeVisible({ timeout: 20_000 });
});

test("#652: somebody who never enrolled can still get in — §6's circle", async ({ page, request }) => {
  test.setTimeout(180_000);
  // The case a policy without a way out makes UNRECOVERABLE: the stance is turned on, and a member who
  // had not enrolled before it went on cannot get a session, cannot reach settings, and can never
  // enrol. Driven end to end because that is the only way to know the loop actually closes — every
  // piece of it passed its own test while the loop was still open.
  const email = `factor-circle-${STAMP}@e2e.test`;
  await setPrefs(false);
  const invited = await request.post("/api/members/invites", {
    data: { email, role: "member", kind: "local" },
    headers: { authorization: "Bearer dev-token", "sec-fetch-site": "same-origin" },
  });
  expect(invited.ok(), `invited (${invited.status()})`).toBe(true);
  const token = new URL((await invited.json() as { inviteUrl: string }).inviteUrl).searchParams.get("token")!;
  const accepted = await request.post("/api/auth/local/accept", {
    data: { token, password: PASSWORD }, headers: { "sec-fetch-site": "same-origin" },
  });
  expect(accepted.ok(), `accepted (${accepted.status()})`).toBe(true);
  strays.push(email);

  // The stance goes on while they hold NOTHING. This is the state an administrator creates by turning
  // the switch on, and the one the interstitial exists for.
  await setPrefs(true);

  await page.context().clearCookies();
  await page.goto(RECOVERY);
  await page.getByTestId("login-local-identifier").fill(email);
  await page.getByTestId("login-local-password").fill(PASSWORD);
  await page.getByTestId("login-local-submit").click();

  // No code box: asking somebody with no authenticator for a code is a question they cannot answer.
  await expect(page.getByTestId("login-factor-enrol-start"), "offered a way to set one up")
    .toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("login-factor-code"), "and nothing to type into yet").toHaveCount(0);

  await page.getByTestId("login-factor-enrol-start").click();
  const key = (await page.getByTestId("login-factor-secret-value").innerText()).replace(/\s/g, "");
  expect(key, "a key to put in an app").toMatch(/^[A-Z2-7]+$/);

  await page.getByTestId("login-factor-enrol-code").fill(totp(key));
  await page.getByTestId("login-factor-enrol-submit").click();
  // Enrolling IS answering — they produced a code from the thing they just registered, in front of us.
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 20_000 });

  await page.goto("/settings/account/security");
  await dismissOverlays(page);
  await expect(page.getByTestId("second-factor-panel"), "in, on the first try").toBeVisible({ timeout: 20_000 });
  await expect(page.locator('[data-testid="factor-row"]'), "…holding the factor they just made")
    .toHaveCount(1, { timeout: 15_000 });
});
