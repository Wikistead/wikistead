import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { openDemo, sleep } from "../helpers";

// #672 (review rejection/): what the admin was told when the pick was refused.
//
// The report, walked: an admin whose account ALREADY HOLDS an authenticator app picks "passkeys only",
// the PATCH answers 409, and the screen says "enrol a second factor on an admin account first". The one
// thing that would let them proceed — two passkeys — appears nowhere, and re-reading the screen never
// produces it. The server had the right sentence all along; it shared a CODE with the ON/OFF switch's
// refusal and the screen mapped the code.
//
// So this reads the SENTENCE, in the state where the wrong one is plausible. A tenant with no factors
// at all would be told to enrol one — correctly — and would pass a test that only checked "a refusal
// appeared". The admin here holds a factor, which is what makes the old wording false.
//
// The second case is the other half of the ruling: an option that could only ever 409 is not offered
// (#606's button that always fails). ⚠️ That is CONVENIENCE. The last case takes the screen out of the
// loop and PATCHes it anyway — #613: a gate that only hides is not a gate.
test.describe.configure({ mode: "serial" });

const TENANT = "tenant_dev";
const STAMP = Date.now().toString(36);
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

/** Everything this file put on the admin, so a run leaves the shared tenant as it found it. */
const clearMine = () =>
  sql`DELETE FROM member_factors WHERE tenant_id = ${TENANT} AND member_sub = ${ADMIN} AND label LIKE 'p672-%'`
    .catch(() => {});

test.beforeAll(async () => {
  const [row] = await sql<Prefs[]>`
    SELECT second_factor_required, second_factor_kinds, local_login_enabled
    FROM tenant_login_prefs WHERE tenant_id = ${TENANT}`;
  prior = row ?? null;
  await clearMine();
});

test.afterAll(async () => {
  await clearMine();
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

/** The admin holds an authenticator app and NO passkey: `any` is satisfied, `passkey` is two short. */
async function adminHoldsOnlyAnApp(): Promise<void> {
  await clearMine();
  await sql`
    INSERT INTO member_factors (tenant_id, member_sub, kind, label, confirmed_at)
    VALUES (${TENANT}, ${ADMIN}, 'totp', ${`p672-app-${STAMP}`}, now())`;
  await setStance("any");
}

test("#672 ①: the refusal names two passkeys, not the factor the admin already has", async ({ page }) => {
  test.setTimeout(240_000);
  await adminHoldsOnlyAnApp();

  await page.addInitScript(() => { try { localStorage.setItem("wks.lang", "en"); } catch { /* private */ } });
  await openDemo(page);
  await page.goto("/admin/auth");
  await expect(page.getByTestId("second-factor-kinds")).toBeVisible({ timeout: 20_000 });
  await sleep(600);

  const said = (await page.getByTestId("stance-refused-passkey").innerText()).replace(/\s+/g, " ");
  // The requirement, in the words the reader needs: how many, and of what.
  expect(said, `the reason says how many keys :: ${said}`).toMatch(/two passkeys/i);
  // …and NOT the sentence that sent them looking at an account that already holds a factor. Written as
  // the discarded wording rather than as "some reason is shown": the old screen showed a reason too.
  expect(said, `it still tells an enrolled admin to enrol :: ${said}`)
    .not.toMatch(/enrol a second factor on an admin account/i);
});

test("#672 ①: an option that could only ever 409 is not offered as a choice", async ({ page }) => {
  test.setTimeout(240_000);
  await adminHoldsOnlyAnApp();

  await page.addInitScript(() => { try { localStorage.setItem("wks.lang", "en"); } catch { /* private */ } });
  await openDemo(page);
  await page.goto("/admin/auth");
  await expect(page.getByTestId("second-factor-kinds")).toBeVisible({ timeout: 20_000 });
  await sleep(600);

  await page.getByTestId("second-factor-kinds-select").click();
  const refused = page.getByRole("option", { name: /passkeys only/i });
  await expect(refused, "the unreachable pick is not selectable").toHaveAttribute("aria-disabled", "true");
  // The CONTROL, and the case that matters most: greying every option would satisfy the line above and
  // leave the screen unusable. `authenticator apps only` is writable here — the admin holds one.
  await expect(page.getByRole("option", { name: /authenticator apps only/i }),
    "a writable pick is still offered").not.toHaveAttribute("aria-disabled", "true");
  await expect(page.getByTestId("stance-refused-totp"),
    "…and carries no reason, because there is nothing to refuse").toHaveCount(0);
});

test("#672: the server refuses it too, for a caller who never saw the picker", async ({ request }) => {
  test.setTimeout(180_000);
  await adminHoldsOnlyAnApp();

  // #613: the greying is convenience; this is the fortress. A stale tab, the API, curl — same wall.
  const res = await request.patch("/api/admin/login-methods", {
    data: { secondFactorKinds: "passkey" },
    headers: { authorization: "Bearer dev-token", "sec-fetch-site": "same-origin" },
  });
  expect(res.status(), "the write was waved through").toBe(409);
  // `message`, not `error`: a thrown Error goes through Fastify's default serialiser, where `error`
  // holds the status name ("Conflict").
  const body = await res.json() as { code: string; message: string };
  expect(body.code, "…and it names WHICH floor, so the screen can say so").toBe("admin_passkey_floor");
  expect(body.message).toMatch(/two passkeys/i);
  expect(await stanceInDb(), "nothing was written").toBe("any");
});
