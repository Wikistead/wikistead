import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { sleep } from "../helpers";

// #678 / ADR-222 §6: somebody who holds nothing signs in, makes a key ON THE SIGN-IN SCREEN, and lands
// in the product — the whole circle, in one walk.
//
// It has to be a browser, and it has to be a real WebAuthn: the server half can be measured with
// injected requests (`interstitial-doors-678`) but "the key was created and the session came back" is a
// claim about a ceremony the browser performs. A virtual authenticator over CDP does it without a
// physical key, which is the instrument #666's reject asked for and the one that found a second bug
// there.
//
// The stance is `passkey`, deliberately. Under `any` this walk would pass on a build where the passkey
// door does not exist at all — the TOTP button is right there. Under `passkey` the key is the only way
// in, so the walk fails if anything on the path is missing.
test.describe.configure({ mode: "serial" });

const TENANT = "tenant_dev";
const STAMP = Date.now().toString(36);
const EMAIL = `p678-door-${STAMP}@e2e.test`;
const PASSWORD = "a real password for the 678 door";
const RECOVERY = "/login/recovery"; // #605's screen renders the password form unconditionally

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

type Prefs = { second_factor_required: boolean; second_factor_kinds: string; local_login_enabled: boolean };
let prior: Prefs | null = null;

const setStance = (kinds: string) => sql`
  INSERT INTO tenant_login_prefs (tenant_id, second_factor_required, second_factor_kinds, local_login_enabled)
  VALUES (${TENANT}, ${kinds !== "off"}, ${kinds}, TRUE)
  ON CONFLICT (tenant_id) DO UPDATE
    SET second_factor_required = ${kinds !== "off"}, second_factor_kinds = ${kinds}, local_login_enabled = TRUE`;

test.beforeAll(async () => {
  const [row] = await sql<Prefs[]>`
    SELECT second_factor_required, second_factor_kinds, local_login_enabled
    FROM tenant_login_prefs WHERE tenant_id = ${TENANT}`;
  prior = row ?? null;
});

test.afterAll(async () => {
  // The SEAT outlives everything else and pushes the tenant past its cap in later runs (#638's leak).
  const mine = sql`SELECT sub FROM members WHERE tenant_id = ${TENANT} AND email = ${EMAIL}`;
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

test("#678: no factor, a passkey made at the sign-in screen, and you are in", async ({ page, request }) => {
  test.setTimeout(240_000);

  // ── a member the product made, with a password and nothing else ─────────────────────────────────
  //
  // Through the invitation: a row written by hand has no FGA membership and `establishMemberSession`
  // refuses it, which comes back as "invalid credentials" and looks like a product bug.
  await setStance("off"); // the invite is accepted while nothing is required
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

  await setStance("passkey");

  // ── the key is created by Chromium, not stubbed ─────────────────────────────────────────────────
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable", { enableUI: false });
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2", transport: "internal", hasResidentKey: true,
      // Both true, or the key answers `userVerified: false` and the server is right to refuse it —
      // a fixture problem that reads exactly like a product bug.
      hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true,
    },
  });

  await page.addInitScript(() => { try { localStorage.setItem("wks.lang", "en"); } catch { /* private */ } });
  await page.goto(RECOVERY);
  await expect(page.getByTestId("login-local"), "the password form is on screen").toBeVisible({ timeout: 20_000 });
  await page.getByTestId("login-local-identifier").fill(EMAIL);
  await page.getByTestId("login-local-password").fill(PASSWORD);
  await page.getByTestId("login-local-submit").click();

  // ── the second step offers the key, and ONLY the key ────────────────────────────────────────────
  await expect(page.getByTestId("login-factor-step"), "a correct password stops here").toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("login-factor-enrol-passkey"), "…offering a key").toBeVisible();
  // The half a build could get wrong while passing everything else: the tenant asked for passkeys, and
  // an authenticator app is not one. Offering it would send this member to a factor their own
  // workspace refuses at the door (#677).
  await expect(page.getByTestId("login-factor-enrol-start"),
    "an authenticator app is not offered under a passkey stance").toHaveCount(0);

  await page.getByTestId("login-factor-enrol-passkey").click();

  // ── and they arrive ─────────────────────────────────────────────────────────────────────────────
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 30_000 });
  const { credentials } = await cdp.send("WebAuthn.getCredentials", { authenticatorId });
  expect(credentials.length, "the authenticator holds the key it just made").toBe(1);

  const [row] = await sql<{ kind: string; confirmed: boolean }[]>`
    SELECT f.kind, f.confirmed_at IS NOT NULL AS confirmed
    FROM member_factors f JOIN members m ON m.sub = f.member_sub
    WHERE m.tenant_id = ${TENANT} AND m.email = ${EMAIL}`;
  expect(row?.kind, "and the server stored a passkey").toBe("passkey");
  expect(row?.confirmed, "…confirmed, not a half-finished enrolment").toBe(true);

  // ── the session is real: it survives a reload, which a client-side redirect would not ────────────
  await page.reload();
  await sleep(800);
  expect(new URL(page.url()).pathname.startsWith("/login"), "still signed in after a reload").toBe(false);
});
