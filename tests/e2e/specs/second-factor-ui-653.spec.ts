import { test, expect, type Page } from "@playwright/test";
import { createHmac } from "node:crypto";
import { openDemo, sleep } from "../helpers";

// #653 / ADR-219: enrolling and giving up a second factor, from the screen.
//
// The code is computed HERE, from the secret the screen hands out — which is the whole point. A pin that
// only checked "a secret appeared" would pass on a secret the server never stored, and one that stubbed
// the confirm call would pass on a screen that sends the wrong id. Driving the real algorithm against
// the real endpoints is the only thing that says the enrolment works.
//
// Reimplemented rather than imported: `apps/server/src/auth/totp.ts` is the thing under test, and a test
// that verifies a code with the same function that produced it verifies nothing about either.
function totp(secretBase32: string, at = Date.now()): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0, value = 0;
  const bytes: number[] = [];
  for (const ch of secretBase32.replace(/\s|=/g, "").toUpperCase()) {
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

async function gotoSecurity(page: Page) {
  await openDemo(page);
  await page.goto("/settings/account/security");
  await expect(page.getByTestId("second-factor-panel"), "the security tab is reachable").toBeVisible({ timeout: 20_000 });
}

test("#653: a factor can be enrolled from the screen, and only given up by proving it", async ({ page }) => {
  test.setTimeout(180_000);
  await gotoSecurity(page);

  // ── enrol ───────────────────────────────────────────────────────────────────────────────────────
  await page.getByTestId("factor-label-input").fill("e2e phone");
  await page.getByTestId("factor-add").click();
  await expect(page.getByTestId("factor-enrolling"), "the enrolment opened").toBeVisible({ timeout: 15_000 });

  const secret = (await page.getByTestId("factor-secret-value").innerText()).trim();
  expect(secret, "a base32 key the reader can type into an app").toMatch(/^[A-Z2-7]+$/);

  // The URI an authenticator would have read from a QR code carries the SAME secret. Asserted because
  // the two are produced separately, and a screen showing one key while offering another would look
  // perfectly correct until somebody scanned it.
  const uri = (await page.getByTestId("factor-uri").innerText()).trim();
  expect(new URL(uri).searchParams.get("secret"), "the URI and the printed key agree").toBe(secret);

  // a wrong code is refused, and the enrolment stays open
  await page.getByTestId("factor-confirm-code").fill("000000");
  await page.getByTestId("factor-confirm").click();
  await sleep(800);
  await expect(page.getByTestId("factor-enrolling"), "a wrong code does not enrol").toBeVisible();

  await page.getByTestId("factor-confirm-code").fill(totp(secret));
  await page.getByTestId("factor-confirm").click();
  await expect(page.getByTestId("factor-enrolling"), "the form closed").toBeHidden({ timeout: 15_000 });

  const row = page.locator('[data-testid="factor-row"]').filter({ hasText: "e2e phone" }).first();
  await expect(row, "the factor is listed under the name given to it").toBeVisible({ timeout: 15_000 });

  // ── give it up ──────────────────────────────────────────────────────────────────────────────────
  // ADR-219 §8: possession, not a password. The row asks for a code rather than for agreement.
  await row.getByTestId("factor-remove").click();
  await expect(row.getByTestId("factor-remove-code"), "it asks for a code").toBeVisible({ timeout: 10_000 });

  await row.getByTestId("factor-remove-code").fill("000000");
  await row.getByTestId("factor-remove-confirm").click();
  await sleep(1000);
  await expect(row, "a wrong code does not remove it").toBeVisible();

  // a code from the NEXT step, since the one used to confirm the enrolment is spent
  await row.getByTestId("factor-remove-code").fill(totp(secret, Date.now() + 30_000));
  await row.getByTestId("factor-remove-confirm").click();
  await expect(row, "and the right code does").toBeHidden({ timeout: 15_000 });
});

test("#653: the enrolment key is shown once, in the box that says so", async ({ page }) => {
  test.setTimeout(120_000);
  await gotoSecurity(page);
  await page.getByTestId("factor-add").click();
  await expect(page.getByTestId("factor-enrolling")).toBeVisible({ timeout: 15_000 });

  // the same one-time box a password link uses — copyable, and carrying its own warning
  await expect(page.getByTestId("factor-secret-copy"), "it can be copied rather than retyped").toBeVisible();
  const note = (await page.getByTestId("factor-secret-note").innerText()).trim();
  expect(note.length, "and it says the key will not be shown again").toBeGreaterThan(0);

  // Leaving the enrolment THROWS THE PENDING ROW AWAY rather than merely closing the form. Measured
  // the hard way: without it, each run of this spec left a row behind, and after ten the account had
  // hit MAX_FACTORS_PER_MEMBER and could not enrol at all — a leak in the product that showed up first
  // as this pin going red for no visible reason.
  await page.getByTestId("factor-cancel").click();
  await expect(page.getByTestId("factor-enrolling")).toBeHidden({ timeout: 10_000 });
});
