import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { openDemo, sleep } from "../helpers";

// #679 / ADR-222: an admin picks WHICH kinds count, from the product, and the door changes with it.
//
// The claim is not "a PATCH was sent". #613's lesson is that a screen can look complete while the
// endpoints stay open, so this walk ends at the door: after the pick, a member holding only an
// authenticator app is refused for its KIND at sign-in. That is the behaviour the setting exists to
// produce, and nothing short of it distinguishes a working picker from a decorative one.
//
// The count in the confirmation is measured with somebody who would actually be swept. A tenant where
// nobody is affected would show "0" and pass a test that only checked the dialog appears.
test.describe.configure({ mode: "serial" });

const TENANT = "tenant_dev";
const STAMP = Date.now().toString(36);
const EMAIL = `p679-swept-${STAMP}@e2e.test`;
const PASSWORD = "a real password for the 679 picker";
const ADMIN = "dev-user";

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

const stanceInDb = async (): Promise<string> => {
  const [row] = await sql<{ v: string }[]>`
    SELECT second_factor_kinds AS v FROM tenant_login_prefs WHERE tenant_id = ${TENANT}`;
  return row?.v ?? "off";
};

/** Two admin passkeys, which is the floor `passkey` asks for (#672 ruling ②-1). */
async function giveAdminPasskeys(): Promise<void> {
  for (const tag of ["a", "b"]) {
    const [f] = await sql<{ id: string }[]>`
      INSERT INTO member_factors (tenant_id, member_sub, kind, label, confirmed_at)
      VALUES (${TENANT}, ${ADMIN}, 'passkey', ${`p679-key-${tag}`}, now()) RETURNING id`;
    await sql`
      INSERT INTO member_passkeys (factor_id, tenant_id, credential_id, public_key, sign_count, transports, rp_id)
      VALUES (${f!.id}, ${TENANT}, ${`cred-679-${tag}-${STAMP}`}, 'pk', 0, ARRAY['usb'], 'dev.localhost')`;
  }
}

test.beforeAll(async () => {
  const [row] = await sql<Prefs[]>`
    SELECT second_factor_required, second_factor_kinds, local_login_enabled
    FROM tenant_login_prefs WHERE tenant_id = ${TENANT}`;
  prior = row ?? null;
});

test.afterAll(async () => {
  await sql`DELETE FROM member_factors WHERE tenant_id = ${TENANT} AND member_sub = ${ADMIN} AND label LIKE 'p679-%'`.catch(() => {});
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

test("#679: picking `passkeys only` says who it costs, and the door obeys", async ({ page, request }) => {
  test.setTimeout(240_000);

  // ── somebody the narrowing will strand: a password, an authenticator app, nothing else ──────────
  await setStance("any");
  const invite = await request.post("/api/members/invites", {
    data: { email: EMAIL, role: "member", kind: "local" },
    headers: { authorization: "Bearer dev-token", "sec-fetch-site": "same-origin" },
  });
  expect(invite.ok(), `the invite was issued :: ${invite.status()}`).toBe(true);
  const token = new URL((await invite.json() as { inviteUrl: string }).inviteUrl).searchParams.get("token")!;
  const accepted = await request.post("/api/auth/local/accept", {
    data: { token, password: PASSWORD }, headers: { "sec-fetch-site": "same-origin" },
  });
  expect(accepted.ok(), `they accepted :: ${accepted.status()}`).toBe(true);
  const [m] = await sql<{ sub: string }[]>`SELECT sub FROM members WHERE tenant_id = ${TENANT} AND email = ${EMAIL}`;
  await sql`
    INSERT INTO member_factors (tenant_id, member_sub, kind, label, confirmed_at)
    VALUES (${TENANT}, ${m!.sub}, 'totp', 'p679-app', now())`;
  await giveAdminPasskeys(); // …or the floor refuses the pick, correctly

  // ── the admin picks, from the screen ────────────────────────────────────────────────────────────
  await page.addInitScript(() => { try { localStorage.setItem("wks.lang", "en"); } catch { /* private */ } });
  await openDemo(page);
  await page.goto("/admin/auth");
  await expect(page.getByTestId("second-factor-kinds"),
    "the picker is on the switchboard once something is required").toBeVisible({ timeout: 20_000 });

  await page.getByTestId("second-factor-kinds-select").click();
  await page.getByRole("option", { name: /passkeys only/i }).click();

  const confirm = page.getByTestId("second-factor-kinds-confirm");
  await expect(confirm, "picking asks first").toBeVisible({ timeout: 15_000 });
  const dialog = page.locator('[role="dialog"]', { has: confirm });
  // The number, and the passkey sentence ruling ②-3 asked for. Measured as TEXT because that is what a
  // reader is given — a count computed correctly and not shown is not a warning.
  const said = (await dialog.innerText()).replace(/\s+/g, " ");
  expect(said, `…and says how many people it costs :: ${said}`).toMatch(/\b1 member\b|\bOne member\b/i);
  await expect(dialog, "…and that a passkey cannot be exported").toContainText(/cannot be exported/i);
  expect(await stanceInDb(), "nothing is written while the question is open").toBe("any");

  await confirm.click();
  await expect.poll(stanceInDb, { timeout: 20_000, message: "the pick was written" }).toBe("passkey");

  // ── the door obeys, which is the only thing that makes the picker real ──────────────────────────
  const login = await request.post("/api/auth/local/login", {
    data: { identifier: EMAIL, password: PASSWORD }, headers: { "sec-fetch-site": "same-origin" },
  });
  const body = await login.json() as { factor?: string; kinds?: string[] };
  expect(body.factor, "their authenticator no longer satisfies the workspace").toBe("enrolment-required");
  expect(body.kinds, "…and they are told which kind to enrol").toEqual(["passkey"]);
});

test("#679: the member's own list says which of their factors stopped counting", async ({ page }) => {
  test.setTimeout(180_000);
  // dev-user holds the two passkeys from the case above plus, here, an authenticator app. Under
  // `passkey` exactly one of the three should be marked — a build marking all or none passes nothing.
  await setStance("passkey");
  await sql`
    INSERT INTO member_factors (tenant_id, member_sub, kind, label, confirmed_at)
    VALUES (${TENANT}, ${ADMIN}, 'totp', 'p679-admin-app', now())`;

  await page.addInitScript(() => { try { localStorage.setItem("wks.lang", "en"); } catch { /* private */ } });
  await openDemo(page);
  await page.goto("/settings/account/security");
  await expect(page.getByTestId("second-factor-panel")).toBeVisible({ timeout: 20_000 });
  await sleep(600);

  const appRow = page.locator('[data-testid="factor-row"]', { hasText: "p679-admin-app" });
  await expect(appRow.getByTestId("factor-not-counted"), "the authenticator says it does not count").toHaveCount(1);
  // Not "p679-a": `hasText` is a SUBSTRING match and "p679-admin-app" starts with it, so the locator
  // resolved to the authenticator row and the case failed saying the passkey was marked. Measured.
  const keyRow = page.locator('[data-testid="factor-row"]', { hasText: "p679-key-a" });
  await expect(keyRow.getByTestId("factor-not-counted"), "…and the passkey carries nothing").toHaveCount(0);

  // …and the mark goes away when the workspace accepts it again — it is about the STANCE, not the row.
  await setStance("any");
  await page.reload();
  await expect(page.getByTestId("second-factor-panel")).toBeVisible({ timeout: 20_000 });
  await sleep(600);
  await expect(page.getByTestId("factor-not-counted"), "nothing is marked under `any`").toHaveCount(0);
});
