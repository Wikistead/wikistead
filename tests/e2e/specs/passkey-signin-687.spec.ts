import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { sleep } from "../helpers";

// #687: somebody whose only factor is a security key SIGNS IN WITH IT. The lock-out this pins.
//
// A real YubiKey found it: the key enrolled fine (#678's walk covers that), and then the second step
// showed a six-digit code box and nothing else. The server had accepted assertions at that door since
// #665 — `POST /auth/local/factor/passkey/options` and `POST /auth/local/factor { passkey }` — and the
// screen never called either. Holding the key was not enough to get in.
//
// ⚠️ THE WALK MUST BE THE PRESENTING HALF, and it must have a GREEN path. #666 shipped eight refusal
// assertions that all stayed green while the feature was broken, because refusals pass whether or not
// the accepting path works. So this spec goes all the way through: enrol → sign OUT → sign in again
// with only the key. The second sign-in is the assertion; everything before it is setup.
//
// The stance is `passkey`: under `any` a build with no passkey door still passes, because the code box
// is right there. Under `passkey` the key is the only way in, so a missing door is a failed walk.
test.describe.configure({ mode: "serial" });

const TENANT = "tenant_dev";
const STAMP = Date.now().toString(36);
const EMAIL = `p687-signin-${STAMP}@e2e.test`;
const PASSWORD = "a real password for the 687 door";
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

test("#687: a member holding only a passkey signs in with it", async ({ page, request }) => {
  test.setTimeout(240_000);

  // ── setup: a member the product made, with a password ───────────────────────────────────────────
  // Through the invitation — a row written by hand has no FGA membership and the session refuses it.
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

  await setStance("passkey");

  // Chromium's own authenticator, kept for BOTH sign-ins — the second one has to answer a challenge
  // for the credential the first one created, which is the whole point.
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

  // ── setup: enrol the key at the sign-in screen (#678's circle, in one step) ─────────────────────
  await page.goto(RECOVERY);
  await expect(page.getByTestId("login-local"), "the password form is on screen").toBeVisible({ timeout: 20_000 });
  await page.getByTestId("login-local-identifier").fill(EMAIL);
  await page.getByTestId("login-local-password").fill(PASSWORD);
  await page.getByTestId("login-local-submit").click();
  await expect(page.getByTestId("login-factor-enrol-passkey"), "the enrolment door is offered").toBeVisible({ timeout: 20_000 });
  await page.getByTestId("login-factor-enrol-passkey").click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 30_000 });

  const { credentials } = await cdp.send("WebAuthn.getCredentials", { authenticatorId });
  expect(credentials.length, "the authenticator holds the key it just made").toBe(1);

  // ── sign OUT: the session goes, the key stays ───────────────────────────────────────────────────
  await page.context().clearCookies();

  // ── THE ASSERTION: sign in again holding nothing but that key ───────────────────────────────────
  await page.goto(RECOVERY);
  await expect(page.getByTestId("login-local"), "back at the password form").toBeVisible({ timeout: 20_000 });
  await page.getByTestId("login-local-identifier").fill(EMAIL);
  await page.getByTestId("login-local-password").fill(PASSWORD);
  await page.getByTestId("login-local-submit").click();

  await expect(page.getByTestId("login-factor-step"), "a correct password stops at the factor").toBeVisible({ timeout: 20_000 });
  // The defect, stated as a screen: a code box was the ONLY thing here, and this member has no code.
  await expect(page.getByTestId("login-factor-passkey"), "the door offers the key they hold").toBeVisible();
  await expect(page.getByTestId("login-factor-code"),
    "a code box is offered to somebody who has no code to type").toHaveCount(0);

  await page.getByTestId("login-factor-passkey").click();

  // ── and they are in ─────────────────────────────────────────────────────────────────────────────
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 30_000 });

  // The session is real: a client-side redirect would not survive a reload.
  await page.reload();
  await sleep(800);
  expect(new URL(page.url()).pathname.startsWith("/login"), "still signed in after a reload").toBe(false);

  // …and it recorded the door it came through, so the factor was genuinely presented rather than
  // waved past (#655: `local+factor` is the only value a satisfied second step may write).
  const [f] = await sql<{ kind: string; confirmed: boolean }[]>`
    SELECT f.kind, f.confirmed_at IS NOT NULL AS confirmed
    FROM member_factors f JOIN members m ON m.sub = f.member_sub
    WHERE m.tenant_id = ${TENANT} AND m.email = ${EMAIL}`;
  expect(f?.kind, "the factor in play is the passkey").toBe("passkey");
  expect(f?.confirmed, "…confirmed, not a half-finished enrolment").toBe(true);
});
