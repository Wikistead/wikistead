import { test, expect } from "@playwright/test";
import { createHmac } from "node:crypto";
import { sleep } from "../helpers";

// #652 / ADR-219 §6: the half-authenticated step, driven from the sign-in screen.
//
// Stubbed at the network, not at the component. What is under test is the SCREEN's reading of the
// server's two answers — "present the one you have" versus "you have nothing yet" — and whether the
// second leads anywhere. Driving the real server would need a tenant with the stance on and a local
// member with a password, which is a server-suite fixture (`factor-enforcement-652`) and already
// measures the endpoints; here the endpoints are the given and the screen is the question.
//
// The code is still computed for real from the secret the stub hands out, so a screen that posts the
// wrong field or the wrong id fails rather than passes on a mock that accepts anything.
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

const SECRET = "JBSWY3DPEHPK3PXP";
// The break-glass screen (#605), which renders the ordinary password form UNCONDITIONALLY. /login hides
// it unless the tenant has selected password sign-in, and this fixture's tenant has not — measured: the
// form was simply absent there. What is under test is the step AFTER the password, so the screen that
// always offers a password is the honest place to drive it from.
const RECOVERY = "/login/recovery";
const json = (body: unknown, status = 200) =>
  ({ status, contentType: "application/json", body: JSON.stringify(body) });

test.describe("#652: the sign-in screen's second step", () => {
  test("asks for a code when the member already holds a factor", async ({ page }) => {
    test.setTimeout(120_000);
    await page.route("**/api/auth/local/login", (r) => r.fulfill(json({ ok: false, factor: "required" })));
    let presented: unknown = null;
    await page.route("**/api/auth/local/factor", async (r) => {
      presented = JSON.parse(r.request().postData() ?? "{}");
      await r.fulfill(json({ ok: true, returnTo: "/" }));
    });

    await page.goto(RECOVERY);
    await expect(page.getByTestId("login-local"), "the password form is on screen").toBeVisible({ timeout: 20_000 });
    await page.getByTestId("login-local-identifier").fill("someone@example.test");
    await page.getByTestId("login-local-password").fill("hunter2");
    await page.getByTestId("login-local-submit").click();

    // The password form is REPLACED, not decorated: there is nothing left to do with it, and leaving
    // it up invites retyping a password that already worked.
    await expect(page.getByTestId("login-factor-step")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("login-local"), "the password step is done").toBeHidden();
    await expect(page.getByTestId("login-factor-enrol-start"), "…and it does not offer enrolment").toHaveCount(0);

    const code = totp(SECRET);
    await page.getByTestId("login-factor-code").fill(code);
    await page.getByTestId("login-factor-submit").click();
    await sleep(600);
    expect(presented, "the code reaches the server as the server names it").toMatchObject({ code });
  });

  test("offers enrolment when there is nothing to present, and the key leads somewhere", async ({ page }) => {
    test.setTimeout(120_000);
    // §6's circle: policy on, never enrolled. Without this path the policy is unrecoverable for
    // everybody who had not enrolled before it was turned on.
    await page.route("**/api/auth/local/login", (r) => r.fulfill(json({ ok: false, factor: "enrolment-required" })));
    await page.route("**/api/auth/local/factor/enrol", (r) =>
      r.fulfill(json({ factorId: "f-652", secret: SECRET, uri: `otpauth://totp/W:a?secret=${SECRET}` }, 201)));
    let confirmed: { url: string; body: unknown } | null = null;
    await page.route("**/api/auth/local/factor/enrol/*/confirm", async (r) => {
      confirmed = { url: r.request().url(), body: JSON.parse(r.request().postData() ?? "{}") };
      await r.fulfill(json({ ok: true, returnTo: "/" }));
    });

    await page.goto(RECOVERY);
    await page.getByTestId("login-local-identifier").fill("newcomer@example.test");
    await page.getByTestId("login-local-password").fill("hunter2");
    await page.getByTestId("login-local-submit").click();

    // No code box yet — asking somebody with no authenticator for a code is unanswerable.
    await expect(page.getByTestId("login-factor-enrol-start")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("login-factor-code"), "nothing to type into yet").toHaveCount(0);

    await page.getByTestId("login-factor-enrol-start").click();
    // #653④: the key is DISPLAYED in groups of four so it can be typed off the screen. The
  // spaces are presentation — the value the server sent has none, and everything that consumes it
  // (the copy button, the phone) gets that one.
  const key = (await page.getByTestId("login-factor-secret-value").innerText()).replace(/\s/g, "");
    expect(key, "the key the phone needs").toBe(SECRET);
    await expect(page.getByTestId("login-factor-secret-copy"), "copyable rather than retyped").toBeVisible();

    // #653THIS screen had no QR while the settings screen did, and the reason was never a
    // missing feature — the server sent `uri` here too and the type dropped it. So the assertion is
    // that the code drawn here carries the server's own string: a component handed `undefined` renders
    // an empty box, which "a QR element exists" would not notice.
    const qr = page.getByTestId("login-factor-qr");
    await expect(qr, "a phone can be pointed at this screen too").toBeVisible();
    expect(await qr.getAttribute("data-qr-value"), "…and it encodes what the server sent")
      .toBe((await page.getByTestId("login-factor-uri").innerText()).trim());
    // Polled, not read once: the encoder is fetched on demand (`QrCode` imports it inside its effect,
    // so a browser-only bundle stays out of Node's import graph), so the canvas appears a tick later.
    await expect.poll(() => qr.evaluate((el) => el.querySelector("canvas") !== null),
      { timeout: 15_000 }).toBe(true);
    expect(await qr.evaluate((el) => el.getBoundingClientRect().width), "big enough for a camera")
      .toBeGreaterThanOrEqual(120);

    const code = totp(SECRET);
    await page.getByTestId("login-factor-enrol-code").fill(code);
    await page.getByTestId("login-factor-enrol-submit").click();
    await sleep(600);
    expect(confirmed, "the confirmation was sent").not.toBeNull();
    expect(confirmed!.url, "…to the enrolment it just started, by id").toContain("/f-652/confirm");
    expect(confirmed!.body).toMatchObject({ code });
  });

  test("a wrong code says so and stays on the step", async ({ page }) => {
    test.setTimeout(120_000);
    await page.route("**/api/auth/local/login", (r) => r.fulfill(json({ ok: false, factor: "required" })));
    await page.route("**/api/auth/local/factor", (r) =>
      r.fulfill(json({ error: "that code did not match", code: "factor_code_invalid" }, 401)));

    await page.goto(RECOVERY);
    await page.getByTestId("login-local-identifier").fill("someone@example.test");
    await page.getByTestId("login-local-password").fill("hunter2");
    await page.getByTestId("login-local-submit").click();
    await expect(page.getByTestId("login-factor-step")).toBeVisible({ timeout: 15_000 });

    await page.getByTestId("login-factor-code").fill("000000");
    await page.getByTestId("login-factor-submit").click();
    await expect(page.getByTestId("login-factor-error"), "it says what happened").toBeVisible({ timeout: 10_000 });
    // …and the box is still there to try again in. A refusal that drops the reader back to the
    // password would ask for the credential that already worked.
    await expect(page.getByTestId("login-factor-code")).toBeVisible();
  });
});

// #672 ruling ③: stranding a browser that cannot do WebAuthn is ACCEPTED — there is no per-member
// exemption, because a permanent TOTP hole in a passkey-only stance is not a passkey-only stance.
// What the ruling asks for instead is that the lockout be LEGIBLE, and it named the pin: the specific
// sentence appears, and folding it back into the generic failure goes red.
//
// The screen is where this has to be measured. `browserSupportsWebAuthn` reads a global that only a
// browser has, and the three cases below differ by what the tenant accepts — which is a decision made
// on the server and carried in the sign-in answer.
test.describe("#672 ③: a browser that cannot do this is told so, on the door", () => {
  const enrolmentRequired = (kinds: string[]) => async (page: import("@playwright/test").Page) => {
    await page.route("**/api/auth/local/login", (r) =>
      r.fulfill(json({ ok: false, factor: "enrolment-required", kinds })));
    await page.goto(RECOVERY);
    await page.getByTestId("login-local-identifier").fill("nowebauthn@example.test");
    await page.getByTestId("login-local-password").fill("hunter2");
    await page.getByTestId("login-local-submit").click();
    await expect(page.getByTestId("login-factor-step")).toBeVisible({ timeout: 20_000 });
  };

  test("passkey-only + no WebAuthn: the sentence names the situation and what to do", async ({ page }) => {
    await page.addInitScript(() => { Reflect.deleteProperty(window, "PublicKeyCredential"); });
    await enrolmentRequired(["passkey"])(page);

    const said = page.getByTestId("login-factor-unsupported");
    await expect(said, "a reader with no WebAuthn is left with no explanation").toBeVisible({ timeout: 10_000 });
    const text = (await said.innerText()).trim();
    // Not "an element exists": the ruling is about what it SAYS. It has to name the cause (this
    // browser) and a way forward, or it is the generic failure wearing a different testid.
    expect(text.length, "the message is empty").toBeGreaterThan(20);
    expect(text, "…and it does not say what to try instead").toMatch(/ブラウザ|browser/i);

    // …and nothing is offered that cannot work. A start button here would be a prompt that can only
    // end in the failure the sentence just explained.
    await expect(page.getByTestId("login-factor-enrol-passkey"), "a key button was offered anyway").toHaveCount(0);
    await expect(page.getByTestId("login-factor-enrol-start"), "…or an authenticator one the tenant refuses")
      .toHaveCount(0);
  });

  test("…but not when the tenant also accepts an authenticator app", async ({ page }) => {
    // The control. This reader is not stranded — the other door is open — and telling them their
    // browser is the problem would send them looking for a different browser they do not need.
    await page.addInitScript(() => { Reflect.deleteProperty(window, "PublicKeyCredential"); });
    await enrolmentRequired(["totp", "passkey"])(page);

    await expect(page.getByTestId("login-factor-unsupported"),
      "told somebody they are stuck while the authenticator door was open").toHaveCount(0);
    await expect(page.getByTestId("login-factor-enrol-start"), "…and the door they can use is offered")
      .toBeVisible({ timeout: 10_000 });
  });

  test("…nor when the browser can do it", async ({ page }) => {
    // The other control: with WebAuthn present the sentence must not appear, or it would be shown to
    // everybody and mean nothing. Both controls together are what stop "always render it" passing.
    await enrolmentRequired(["passkey"])(page);
    await expect(page.getByTestId("login-factor-unsupported")).toHaveCount(0);
    await expect(page.getByTestId("login-factor-enrol-passkey"), "the key door is offered instead")
      .toBeVisible({ timeout: 10_000 });
  });
});
