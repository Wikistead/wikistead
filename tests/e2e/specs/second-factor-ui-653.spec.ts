import { test, expect, type Page } from "@playwright/test";
import { createHmac } from "node:crypto";
import { openDemo, sleep } from "../helpers";
import { decodePng } from "../paint";

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

  // #653④: the key is DISPLAYED in groups of four so it can be typed off the screen. The
  // spaces are presentation — the value the server sent has none, and everything that consumes it
  // (the copy button, the phone) gets that one.
  const secret = (await page.getByTestId("factor-secret-value").innerText()).replace(/\s/g, "");
  expect(secret, "a base32 key the reader can type into an app").toMatch(/^[A-Z2-7]+$/);

  // The URI an authenticator would have read from a QR code carries the SAME secret. Asserted because
  // the two are produced separately, and a screen showing one key while offering another would look
  // perfectly correct until somebody scanned it.
  const uri = (await page.getByTestId("factor-uri").innerText()).trim();
  expect(new URL(uri).searchParams.get("secret"), "the URI and the printed key agree").toBe(secret);

  // #653 (ruling): the QR carries THAT string. Asserted on what was handed to the encoder rather than
  // on the picture, because a canvas with the wrong text in it looks exactly like one with the right
  // text in it — "an image appeared" is green on a code that sets up somebody else's account.
  const qr = page.getByTestId("factor-qr");
  await expect(qr, "there is a QR to scan").toBeVisible();
  expect(await qr.getAttribute("data-qr-value"), "…and it encodes the server's own URI").toBe(uri);
  // Black on white whatever the theme: a QR read is the contrast between the two, and a dark theme
  // that inverted it would draw a code no phone can see.
  expect(await qr.evaluate((el) => getComputedStyle(el).backgroundColor), "white quiet zone")
    .toBe("rgb(255, 255, 255)");
  expect(await qr.evaluate((el) => el.querySelector("canvas") !== null), "something was drawn").toBe(true);

  // …and what was drawn DEPENDS ON THE VALUE. `data-qr-value` says what the encoder was handed; these
  // pixels say what a camera would see, and the two are different claims — a component that drew a
  // fixed placeholder would satisfy the first and fail nobody until a phone was pointed at it.
  //
  // Measured by ink rather than by decoding: a decoder is a dependency, and this answers the question
  // that matters without one. The "different value draws different pixels" half is in the test below,
  // where two enrolments can be started; here it is the shape of what was drawn.
  const ink = async () => {
    const png = decodePng(await qr.screenshot());
    let dark = 0;
    for (let i = 0; i < png.data.length; i += 4) if (png.data[i]! < 128) dark++;
    return { dark, total: png.data.length / 4, bytes: Buffer.from(png.data).toString("base64") };
  };
  const drawn = await ink();
  // A QR is roughly a third dark. Far outside that and something is wrong in a way "a canvas exists"
  // cannot see — a blank box, or a solid one.
  expect(drawn.dark / drawn.total, "it looks like a code, not a blank or a block").toBeGreaterThan(0.1);
  expect(drawn.dark / drawn.total, "…and not a solid square").toBeLessThan(0.6);
  expect(await qr.evaluate((el) => el.getBoundingClientRect().width), "big enough for a camera")
    .toBeGreaterThanOrEqual(120);


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

test("#653: an abandoned enrolment is visible and removable, not an invisible one", async ({ page }) => {
  test.setTimeout(180_000);
  //①: the cap counts pending rows and the list used to hide them, so three closed tabs became
  // "you can create it, you cannot see it, and because you cannot see it you cannot delete it" — an
  // account that could never enrol again, with nothing on screen to say why. Two rules that were each
  // right, and a trap where they met.
  await gotoSecurity(page);
  const before = await page.locator('[data-testid="factor-row"]').count();

  await page.getByTestId("factor-add").click();
  await expect(page.getByTestId("factor-enrolling")).toBeVisible({ timeout: 15_000 });
  // leave WITHOUT cancelling — the way people actually abandon things
  await page.goto("/settings/account");
  await gotoSecurity(page);

  const rows = page.locator('[data-testid="factor-row"]');
  await expect(rows, "the abandoned start is there to see").toHaveCount(before + 1, { timeout: 15_000 });
  const stray = rows.last();
  await expect(stray.getByTestId("factor-pending-mark"), "…named as unfinished, not as a factor").toBeVisible();

  // …and it goes without a code, because it guards nothing (#660)
  await stray.getByTestId("factor-remove").click();
  await expect(rows, "and it can be cleared").toHaveCount(before, { timeout: 15_000 });
});

test("#653: reaching the cap says so, permanently, instead of \"try again\"", async ({ page }) => {
  test.setTimeout(180_000);
  //②: the 409 was swallowed into the generic start failure, so a state that lasts until
  // something is REMOVED was reported as one that might work on the next press. Stubbed at the network
  // because filling the account for real costs ten round trips to say one thing about the screen.
  await page.route("**/api/me/factors/totp", (r) => r.request().method() === "POST"
    ? r.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "full", code: "factor_limit_reached" }) })
    : r.fallback());
  await gotoSecurity(page);

  await page.getByTestId("factor-add").click();
  await expect(page.getByTestId("factor-limit-note"), "the screen says what happened").toBeVisible({ timeout: 15_000 });
  // …and the button stops offering something that cannot work
  await expect(page.getByTestId("factor-add"), "the affordance is withdrawn").toBeDisabled();
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
  // …and the QR's PIXELS come from the key, not from a fixture. Two enrolments have different secrets,
  // so two QRs must differ; a component drawing a fixed placeholder would pass every assertion about
  // `data-qr-value` and fail nobody until a phone was pointed at it.
  const shot = () => page.getByTestId("factor-qr").screenshot();
  const firstQr = await shot();
  const firstKey = (await page.getByTestId("factor-secret-value").innerText()).replace(/\s/g, "");

  await page.getByTestId("factor-cancel").click();
  await expect(page.getByTestId("factor-enrolling")).toBeHidden({ timeout: 10_000 });

  await page.getByTestId("factor-add").click();
  await expect(page.getByTestId("factor-enrolling")).toBeVisible({ timeout: 15_000 });
  const secondKey = (await page.getByTestId("factor-secret-value").innerText()).replace(/\s/g, "");
  expect(secondKey, "the premise: a new enrolment is a new key").not.toBe(firstKey);
  expect(Buffer.compare(await shot(), firstQr), "a different key draws a different code").not.toBe(0);

  await page.getByTestId("factor-cancel").click();
  await expect(page.getByTestId("factor-enrolling")).toBeHidden({ timeout: 10_000 });
});

test("#652: the last admin is told WHY, not that their code was wrong", async ({ page }) => {
  test.setTimeout(120_000);
  // The floor (ADR-219 §4) refuses the last admin's factor while the policy is on, and the code they
  // typed is RIGHT. Reporting "that code did not match" sends them back to the authenticator for
  // another one, which is refused for the same unstated reason — a loop with no exit in it.
  //
  // Stubbed at the network: reaching this state for real means being the last admin of a tenant with
  // the stance on, which the server suite already measures. What is under test is what the SCREEN
  // says when the server says this.
  await page.route("**/api/me/factors", (r) => r.request().method() === "GET"
    ? r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ factors: [
        { id: "f-last", kind: "totp", label: "only one", createdAt: new Date().toISOString(),
          confirmedAt: new Date().toISOString(), lastUsedAt: null },
      ] }) })
    : r.fallback());
  await page.route("**/api/me/factors/f-last**", (r) => r.request().method() === "DELETE"
    ? r.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({
        error: "you are the last admin who can sign in under this tenant's second-factor requirement — enrol another authenticator, or turn the requirement off, before removing this one",
        code: "last_admin_factor",
      }) })
    : r.fallback());

  await gotoSecurity(page);
  const row = page.locator('[data-testid="factor-row"]').filter({ hasText: "only one" }).first();
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.getByTestId("factor-remove").click();
  await row.getByTestId("factor-remove-code").fill("123456");
  await row.getByTestId("factor-remove-confirm").click();

  // The message names the two ways out, and does NOT blame the code.
  const toast = page.locator('[data-sonner-toast], [role="status"], [role="alert"]').first();
  await expect(toast).toBeVisible({ timeout: 15_000 });
  const said = (await toast.innerText()).toLowerCase();
  // The screen's own sentence, translated — the server's prose never reaches the client (ApiError's
  // message is built from the status and the path), and it is English only besides.
  expect(said, `it explains rather than blaming the code: "${said}"`).toContain("last admin");
  expect(said, "…and it does not say the code was wrong").not.toMatch(/did not match|一致しません/);

  // …and the factor is still there, which is the point of the refusal
  await expect(row).toBeVisible();
});
