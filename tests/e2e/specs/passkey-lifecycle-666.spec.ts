import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { openDemo, sleep, nameNewestFactor } from "../helpers";

// #666the GREEN path — a passkey is registered, and then it comes OFF by signing with itself.
//
// The reject was decisive and reproduced here before writing this: putting the bug back (making
// `verifyPasskeyForRemoval` return false) left all eight server pins green, because every one of them
// observed a REFUSAL. A set that only measures what is turned away cannot tell a working removal from
// one that is impossible, and #666 is precisely "impossible".
//
// The instrument is the browser's own WebAuthn, driven by a VIRTUAL authenticator over CDP. Nothing is
// stubbed: the key is created by Chromium, the assertion is signed by Chromium, and the server verifies
// it with the same code a physical key would meet. What a person still has to judge is the feel of a
// real key (the prompt, the touch) and the wording — not whether the mechanism works.
//
// It also closes the second half of the reject: the product had NO way to register a passkey (the #663
// endpoints had no caller), so the removal this ticket fixed was unreachable for anybody who had not
// been given a key by hand. Registering through the screen is step one here.
test.describe.configure({ mode: "serial" });

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

test.afterAll(async () => {
  // Both cases enrol against `dev-user`, whose factors are shared with every other spec in the run.
  // Only this file's labels go: a blanket delete would take one another spec is mid-way through.
  await sql`DELETE FROM member_factors WHERE label LIKE 'key-666-%'`.catch(() => {});
  await sql.end();
});

async function virtualKey(page: import("@playwright/test").Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable", { enableUI: false });
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      // Both true, or the key answers with `userVerified: false` and the server is right to refuse it.
      // A spec that flipped these would look like a product bug and be one only in the fixture.
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  return { cdp, authenticatorId };
}

const openSecurity = async (page: import("@playwright/test").Page, lang = "en") => {
  await page.addInitScript((l) => { try { localStorage.setItem("wks.lang", l as string); } catch { /* private */ } }, lang);
  await openDemo(page);
  await page.goto("/settings/account/security");
  await expect(page.getByTestId("second-factor-panel")).toBeVisible({ timeout: 20_000 });
  await sleep(400);
};

const rowFor = (page: import("@playwright/test").Page, label: string) =>
  page.locator('[data-testid="factor-row"]', { hasText: label });

test("#666: a passkey registered from the screen comes off by signing with itself", async ({ page }) => {
  test.setTimeout(240_000);
  const { cdp, authenticatorId } = await virtualKey(page);
  const label = `key-666-${Date.now().toString(36)}`;

  await openSecurity(page);

  // ── register ───────────────────────────────────────────────────────────────────────────────────
  // #653enrolment takes no name. The key is registered first and named afterwards, which is
  // also the walk a person makes now.
  await page.getByTestId("factor-add-passkey").click();
  await nameNewestFactor(page, label);
  await expect(rowFor(page, label), "the key is listed once it is registered").toBeVisible({ timeout: 30_000 });
  // Registered, not merely started: an unconfirmed row also appears in the list, and the pending mark is
  // what tells them apart. This is the difference between "the browser was asked" and "the key answered".
  await expect(rowFor(page, label).getByTestId("factor-pending-mark"),
    "…and it is confirmed, not a half-finished enrolment").toHaveCount(0);
  // Chromium holds it too, which is the independent witness that a key was created rather than a row
  // written by a server that trusted the request.
  const { credentials } = await cdp.send("WebAuthn.getCredentials", { authenticatorId });
  expect(credentials.length, "the authenticator holds the credential").toBe(1);

  // ── and off again, by signing ──────────────────────────────────────────────────────────────────
  const row = rowFor(page, label);
  // #673 ①: one entry point for every kind; the key is asked for after the click, not before it.
  await expect(row.getByTestId("factor-remove"), "the row is removed the way every row is").toBeVisible();
  await row.getByTestId("factor-remove").click();
  await expect(row.getByTestId("factor-remove-code"), "…and never with a typed code").toHaveCount(0);

  // #673and what it SAYS names what went. This is the ceremony path — `factor-kind-naming`
  // reads the same sentence on the plain one — and it is the path that had the kind as a constant, so
  // the two together cover both ways the noun can be got wrong.
  //
  // The VERB is required as well as the noun. Enrolling raised its own toast a moment ago and that one
  // also says "passkey" — asking only for the noun would be answered by the message about adding it,
  // and would stay green with the removal sentence back to naming the wrong kind.
  await expect(
    page.locator("[data-sonner-toast]").filter({ hasText: /removed|削除/i }),
    "removing a passkey does not say a passkey went",
  ).toContainText(/passkey|パスキー/i, { timeout: 30_000 });

  await expect(rowFor(page, label), "the key is gone").toHaveCount(0, { timeout: 30_000 });
  // The row could vanish because the list was refetched into an error state. Reload and ask the server
  // again: what is being claimed is that the FACTOR is gone, not that a component unmounted.
  await page.reload();
  await expect(page.getByTestId("second-factor-panel")).toBeVisible({ timeout: 20_000 });
  await sleep(600);
  await expect(rowFor(page, label), "…and still gone when the server is asked afresh").toHaveCount(0);
});

test("#666: without the key, the removal is refused and the factor stays", async ({ page }) => {
  test.setTimeout(240_000);
  const { cdp, authenticatorId } = await virtualKey(page);
  const label = `key-666-kept-${Date.now().toString(36)}`;

  await openSecurity(page);
  await page.getByTestId("factor-add-passkey").click();
  await nameNewestFactor(page, label);
  await expect(rowFor(page, label)).toBeVisible({ timeout: 30_000 });

  // Take the key away — the shape of losing the phone, and the only control that proves the assertion
  // is what carries the removal. Without it, the case above would pass on a server that deleted the row
  // for anybody who asked.
  await cdp.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId });

  await rowFor(page, label).getByTestId("factor-remove").click();
  await sleep(2500);
  await expect(rowFor(page, label), "no key, no removal").toBeVisible();
  await page.reload();
  await expect(page.getByTestId("second-factor-panel")).toBeVisible({ timeout: 20_000 });
  await sleep(600);
  await expect(rowFor(page, label), "…and the server still holds it").toBeVisible();

  // Deliberately left in place: a NEW authenticator cannot sign for a credential it never held, which
  // is the real-world state this case describes (the phone is gone). `afterAll` clears it at the
  // database level — every factor costs a slot against the per-member limit, and a run that left one
  // behind would meet a 409 on the next run and look like a product bug.
  void cdp;
});
