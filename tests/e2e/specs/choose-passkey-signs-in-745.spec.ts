import { test, expect } from "@playwright/test";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { sleep } from "../helpers";

// #745 a member who holds BOTH proofs picks the passkey — and that press is the whole ceremony.
//
// The owner met it at the screen: pressing "Use passkey" only revealed a second button asking to
// confirm with the passkey, and there was nothing to decide in between. The fix starts the ceremony on
// the choice itself, because that click is the user activation WebAuthn needs.
//
// ⚠️ WHY AN E2E, when a unit pin already drives the screen. The unit pin (choice-starts-the-ceremony-745)
// mounts the door in happy-dom, clicks the choice and watches the options request go out — which proves
// the wiring and nothing about the ceremony, because happy-dom has no WebAuthn. What is unmeasured
// there is exactly what changed: whether the browser still performs `navigator.credentials.get()` when
// the call chain starts from the CHOICE button. #666 is the precedent that keeps this spec honest —
// eight green refusal assertions once sat on top of an accepting path that did not work.
//
// ⚠️ AND WHY A SECOND SPEC, next to passkey-signin-687. That one walks the member who holds ONLY a key:
// the door skips the chooser for them (#745's own ruling), so it exercises the single button and never
// the choice. This member holds a code as well, which is the shape the owner reported.
test.describe.configure({ mode: "serial" });

/** Recomputed here, as #652 does: verifying a code with the function that produced it verifies neither. */
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
const EMAIL = `choose745-${STAMP}@e2e.test`;
const PASSWORD = "a real password for the 745 chooser";
const RECOVERY = "/login/recovery"; // #605's screen renders the password form unconditionally

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

type Prefs = { second_factor_required: boolean; second_factor_kinds: string; local_login_enabled: boolean };
let prior: Prefs | null = null;

const setStance = (kinds: string) => sql`
  INSERT INTO tenant_login_prefs (tenant_id, second_factor_required, second_factor_kinds, local_login_enabled)
  VALUES (${TENANT}, ${kinds !== "off"}, ${kinds}, TRUE)
  ON CONFLICT (tenant_id) DO UPDATE
    SET second_factor_required = ${kinds !== "off"}, second_factor_kinds = ${kinds}, local_login_enabled = TRUE`;

/** The onboarding dialog covers the page; dismissing it is part of being a new member (#652). */
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

test.beforeAll(async () => {
  const [row] = await sql<Prefs[]>`
    SELECT second_factor_required, second_factor_kinds, local_login_enabled
    FROM tenant_login_prefs WHERE tenant_id = ${TENANT}`;
  prior = row ?? null;
});

test.afterAll(async () => {
  // The SEAT outlives everything else and pushes the tenant past its cap in later runs (#638's leak).
  const mine = sql`SELECT sub FROM members WHERE tenant_id = ${TENANT} AND email = ${EMAIL}`;
  await sql`DELETE FROM member_passkeys WHERE factor_id IN (SELECT id FROM member_factors WHERE member_sub IN (${mine}))`.catch(() => {});
  await sql`DELETE FROM member_factors WHERE member_sub IN (${mine})`.catch(() => {});
  await sql`DELETE FROM local_credentials WHERE tenant_id = ${TENANT} AND member_sub IN (${mine})`.catch(() => {});
  await sql`DELETE FROM invites WHERE tenant_id = ${TENANT} AND email = ${EMAIL}`.catch(() => {});
  await sql`DELETE FROM members WHERE tenant_id = ${TENANT} AND email = ${EMAIL}`.catch(() => {});
  if (prior) {
    await sql`
      UPDATE tenant_login_prefs
      SET second_factor_required = ${prior.second_factor_required},
          second_factor_kinds = ${prior.second_factor_kinds},
          local_login_enabled = ${prior.local_login_enabled}
      WHERE tenant_id = ${TENANT}`.catch(() => {});
  }
  await sql.end();
});

test("#745: choosing the passkey signs them in — no second press", async ({ page, request }) => {
  test.setTimeout(300_000);

  // ── a member the product made, holding a password ───────────────────────────────────────────────
  await setStance("off");
  const invite = await request.post("/api/members/invites", {
    data: { email: EMAIL, role: "member", kind: "local" },
    headers: { authorization: "Bearer dev-token", "sec-fetch-site": "same-origin" },
  });
  expect(invite.ok(), `the invite was issued :: ${invite.status()} ${await invite.text()}`).toBe(true);
  const token = new URL((await invite.json() as { inviteUrl: string }).inviteUrl).searchParams.get("token")!;
  const accepted = await request.post("/api/auth/local/accept", {
    data: { token, password: PASSWORD }, headers: { "sec-fetch-site": "same-origin" },
  });
  expect(accepted.ok(), `they accepted and chose a password :: ${accepted.status()}`).toBe(true);

  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable", { enableUI: false });
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2", transport: "internal", hasResidentKey: true,
      // Both true, or the key answers `userVerified: false` and the server is right to refuse it.
      hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true,
    },
  });
  await page.addInitScript(() => { try { localStorage.setItem("wks.lang", "en"); } catch { /* private */ } });

  // ── sign in with the password alone, then set up BOTH proofs from the settings screen ───────────
  await page.goto(RECOVERY);
  await expect(page.getByTestId("login-local"), "the password form is on screen").toBeVisible({ timeout: 20_000 });
  await page.getByTestId("login-local-identifier").fill(EMAIL);
  await page.getByTestId("login-local-password").fill(PASSWORD);
  await page.getByTestId("login-local-submit").click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 30_000 });
  await dismissOverlays(page);

  await page.goto("/settings/account/security");
  await expect(page.getByTestId("second-factor-panel")).toBeVisible({ timeout: 20_000 });
  await dismissOverlays(page);

  await page.getByTestId("factor-add").click(); // the authenticator app
  await expect(page.getByTestId("factor-enrolling")).toBeVisible({ timeout: 15_000 });
  const secret = (await page.getByTestId("factor-secret-value").innerText()).replace(/\s/g, "");
  await page.getByTestId("factor-confirm-code").fill(totp(secret));
  await page.getByTestId("factor-confirm").click();
  await expect(page.getByTestId("factor-enrolling"), "the code was accepted").toBeHidden({ timeout: 15_000 });

  await page.getByTestId("factor-add-passkey").click(); // and the key, on the same account
  await expect(page.getByTestId("factor-row"), "the account now holds two proofs")
    .toHaveCount(2, { timeout: 20_000 });
  const { credentials } = await cdp.send("WebAuthn.getCredentials", { authenticatorId });
  expect(credentials.length, "the authenticator holds the key it just made").toBe(1);

  // `any`, so the door offers both — under a single-kind stance the chooser never appears and this
  // spec would quietly measure the direct path that #687 already walks.
  await setStance("any");

  // ── THE ASSERTION: sign in again, pick the passkey, and that is the last press ──────────────────
  await page.context().clearCookies();
  await page.goto(RECOVERY);
  await expect(page.getByTestId("login-local"), "back at the password form").toBeVisible({ timeout: 20_000 });
  await page.getByTestId("login-local-identifier").fill(EMAIL);
  await page.getByTestId("login-local-password").fill(PASSWORD);
  await page.getByTestId("login-local-submit").click();

  await expect(page.getByTestId("login-factor-choices"), "a member with two proofs is asked which one")
    .toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("login-factor-choose-totp")).toBeVisible();

  await page.getByTestId("login-factor-choose-passkey").click();

  // Nothing else is pressed after this line. That is the assertion — the defect was a second button
  // standing between the choice and the ceremony, and a spec that clicked it would pass either way.
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 30_000 });

  // The session is real: a client-side redirect would not survive a reload.
  await page.reload();
  await sleep(800);
  expect(new URL(page.url()).pathname.startsWith("/login"), "still signed in after a reload").toBe(false);
});
