import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { openDemo } from "../helpers";

// #653③: what the screen says when a passkey enrolment does NOT succeed.
//
// The successful arc — register, listed, given up by signing — is measured in `passkey-lifecycle-666`,
// and is not repeated here. What that file cannot see is the three ways it fails, which the ticket asks
// to be told apart because their recoveries have nothing in common: a browser that cannot run the
// ceremony (use another one), a prompt the reader dismissed (press it again), a key already enrolled
// (it is in the list). One sentence for all three sends somebody looking for a fault in a key that
// works perfectly.
//
// Driven against a VIRTUAL AUTHENTICATOR — Chromium's own WebAuthn, with a software key — so the
// ceremony really starts and really ends the way it is being claimed to.
test.describe.configure({ mode: "serial" });

/**
 * A software security key inside the browser.
 *
 * `hasResidentKey`/`hasUserVerification` on, and `isUserVerified` true: WebAuthn's own registration
 * options ask for user verification, and an authenticator that cannot supply it makes the ceremony fail
 * for a reason that has nothing to do with the code under test.
 */
async function addVirtualKey(context: BrowserContext, page: Page) {
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable", { enableUI: false });
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2", transport: "internal", hasResidentKey: true,
      hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true,
    },
  });
  return {
    id: authenticatorId,
    credentials: async () => (await cdp.send("WebAuthn.getCredentials", { authenticatorId })).credentials,
    /** Stop answering, the way a key left in a drawer does. */
    silence: () => cdp.send("WebAuthn.setAutomaticPresenceSimulation", { authenticatorId, enabled: false }),
    remove: () => cdp.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId }),
  };
}

async function gotoSecurity(page: Page) {
  await openDemo(page);
  await page.goto("/settings/account/security");
  await expect(page.getByTestId("second-factor-panel"), "the security tab is reachable")
    .toBeVisible({ timeout: 20_000 });
}

test("#653: a dismissed prompt is not reported as a broken key", async ({ page, context }) => {
  test.setTimeout(180_000);
  //③: three situations, three recoveries. Pressing Escape is the reader deciding not to, and
  // telling them "that key could not be registered" sends them to look for a fault in the key.
  //
  // A silenced authenticator is how Chrome models the prompt going unanswered: the ceremony aborts with
  // the spec's NotAllowedError, which is exactly what a cancel produces.
  const key = await addVirtualKey(context, page);
  const name = `e2e cancel ${Date.now().toString(36)}`;

  try {
    await gotoSecurity(page);
    // Counted over CONFIRMED rows only. Starting an enrolment sweeps the member's other unconfirmed
    // rows server-side (`discardPendingFactors`), so a total taken beforehand can legitimately shrink
    // — and a test that read that as "my row survived" would be measuring somebody else's debris.
    const confirmed = () => page.locator('[data-testid="factor-row"]')
      .filter({ hasNot: page.getByTestId("factor-pending-mark") });
    const before = await confirmed().count();

    // Silenced: the ceremony starts and then waits for a key that never answers — which is the state a
    // reader is in while the prompt sits on screen, and what WebAuthn reports when they walk away from
    // it. The wait is REAL (sixty seconds, the library's default) rather than shortened, because the
    // thing being measured is what the screen does when the ceremony ends that way.
    await key.silence();
    await page.getByTestId("factor-label-input").fill(name);
    await page.getByTestId("factor-add-passkey").click();

    // Asserted as what the screen SAID, not as what it did not say: `.not.toContain` on a page that
    // never spoke passes, and a silent failure is exactly the outcome this test exists to rule out.
    await expect.poll(async () => (await page.locator("[data-sonner-toast], [role=status]").allInnerTexts()).join(" | "),
      { timeout: 100_000, intervals: [1000] }).toContain("cancelled");
    const said = (await page.locator("[data-sonner-toast], [role=status]").allInnerTexts()).join(" | ");
    expect(said, "a dismissed prompt was reported as a broken key").not.toContain("could not be registered");

    // The half-made row is thrown away rather than left counting toward the cap of ten —①'s
    // defect in the shape this path takes. Measured after a reload, so it is the SERVER's answer and
    // not this page's optimism.
    await page.reload();
    await expect(page.getByTestId("second-factor-panel")).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('[data-testid="factor-row"]').filter({ hasText: name }),
      "a dismissed ceremony left its half-made row behind, which the cap counts")
      .toHaveCount(0, { timeout: 20_000 });
    await expect(confirmed(), "…and nothing that was finished was disturbed")
      .toHaveCount(before, { timeout: 20_000 });
  } finally {
    await key.remove().catch(() => {});
  }
});

test("#653: a browser that cannot do this says so, rather than failing at the key", async ({ page }) => {
  test.setTimeout(120_000);
  // The third recovery: use another browser. Told apart from the other two because there is nothing to
  // retry — pressing again produces the same nothing, forever.
  //
  // MEASURED ON THE MESSAGE AND ON THE WIRE, not on the row count. Counting rows cannot see this: with
  // the guard removed the server still hands out a challenge, the ceremony still fails, and the catch
  // still throws the half-made row away — so the count matches either way. (It did: this test passed
  // with the guard deleted until it was rewritten.) What actually differs is WHAT THE READER IS TOLD,
  // and whether a browser that cannot finish is allowed to start.
  await page.addInitScript(() => {
    // What `browserSupportsWebAuthn()` reads. Deleted before any app code runs.
    Reflect.deleteProperty(window, "PublicKeyCredential");
  });
  let started = 0;
  await page.route((url) => url.pathname === "/api/me/factors/passkey", (route) => {
    if (route.request().method() === "POST") started++;
    return route.fallback();
  });
  await gotoSecurity(page);

  await page.getByTestId("factor-add-passkey").click();
  await expect.poll(async () => (await page.locator("[data-sonner-toast], [role=status]").allInnerTexts()).join(" | "),
    { timeout: 30_000, intervals: [500] }).toContain("browser");

  // …and nothing was started on the server. A challenge issued to a browser that cannot answer it is a
  // row against the cap, bought for nothing.
  expect(started, "an unsupported browser was still allowed to start an enrolment").toBe(0);
});
