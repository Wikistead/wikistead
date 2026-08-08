import { test, expect, type Page } from "@playwright/test";
import { openDemo, sleep } from "../helpers";

// #682: two lines came off the second-factor panel, and the screen states each fact once.
//
// The removed sentences are pinned by their ABSENCE (the #671 shape). A pin on the new state alone goes
// green with the old line still sitting two rows up, which is how the last cleanup of this surface
// passed while saying nothing.
//
// Alongside that, one claim that survives a rewrite: INSTRUCTIONS BELONG TO THE OPERATION. The line that
// went gave the steps of enrolling to somebody who had not started, on a screen that enrols two kinds;
// the same steps already appear the moment the key is on screen. So what is required is not the absence
// of a string but that the steps are absent BEFORE and present AFTER — which stays true however either
// sentence is worded, and goes red if somebody reinstates a panel-level how-to under a new key.

const GONE = {
  // #653④'s domain note (ruled out: nothing the reader can act on — #664 warns the admin inside
  // the move and #680 refuses it outright while passkeys are the only accepted kind)
  domain: { ja: "登録したときのドメインでのみ使えます", en: "only works on the host it was created for" },
  // the panel-level how-to
  howto: { ja: "認証アプリに登録し、表示されたコードで確認してください", en: "Add the app on your phone" },
};

async function openSecurity(page: Page, lang: "en" | "ja") {
  await page.addInitScript((l) => localStorage.setItem("wks.lang", l as string), lang);
  await openDemo(page);
  await page.goto("/settings/account/security");
  await expect(page.getByTestId("second-factor-panel")).toBeVisible({ timeout: 20_000 });
  await sleep(300);
}

for (const lang of ["en", "ja"] as const) {
  test(`#682: the two lines are gone from the panel (${lang})`, async ({ page }) => {
    test.setTimeout(120_000);
    await openSecurity(page, lang);
    const text = await page.locator("body").innerText();

    expect(text, `the domain note is still on the panel (${lang})`).not.toContain(GONE.domain[lang]);
    expect(text, `the panel-level how-to is still there (${lang})`).not.toContain(GONE.howto[lang]);

    // The premise, so that "absent" cannot be satisfied by a screen that failed to render: the things
    // the ruling KEEPS are here.
    expect(text, "the panel's own description went too").toMatch(/two-factor authentication|2 要素認証/i);
  });

  test(`#682: the steps appear when there are steps to take, not before (${lang})`, async ({ page }) => {
    test.setTimeout(120_000);
    await openSecurity(page, lang);

    // Counted, not matched. An earlier version of this asked whether the prose named an "authenticator
    // app" — and stayed GREEN when the deleted English line was put back, because that line said "the
    // app on your phone". A claim about instructions must not hinge on which noun an instruction picks.
    //
    // So: BEFORE anything is started the panel says nothing at all, and once there is a key on screen
    // it says something. That is the ruling itself, in a form no rewording can slip past.
    const panel = page.getByTestId("second-factor-panel");
    /** What the panel SAYS: not what it offers (controls), lists (rows), or warns when full. */
    const prose = (root: ReturnType<Page["getByTestId"]>) => root.evaluate((el) => {
      const clone = el.cloneNode(true) as HTMLElement;
      clone.querySelectorAll('[data-testid="factor-list"], [data-testid="factor-limit-note"], button, input, label')
        .forEach((n) => n.remove());
      return ((clone as HTMLElement).innerText ?? clone.textContent ?? "").trim();
    });

    expect(await prose(panel), "the panel is telling somebody who has not started what to do")
      .toBe("");

    await panel.getByTestId("factor-add").click();
    await expect(page.getByTestId("factor-enrolling")).toBeVisible({ timeout: 20_000 });
    // …and the other half, so "say nothing" cannot be satisfied by a screen that never explains itself.
    expect((await prose(page.getByTestId("factor-enrolling"))).length,
      "there is a key on screen and nothing says what to do with it").toBeGreaterThan(20);

    // Put the row back: an abandoned enrolment costs a slot against the per-member cap, and a run that
    // leaves ten of them stops every other spec on this screen from enrolling at all.
    await page.getByTestId("factor-cancel").click();
    await expect(page.getByTestId("factor-enrolling")).toHaveCount(0, { timeout: 15_000 });
  });
}

// The sweep the ticket asked for, and what it turned up. #653③ ruled that the one-time box
// already says "shown once, copy it now", so a note under it must not say the same thing in other
// words. That was applied to the settings panel; the SAME box on the sign-in-time enrolment screen kept
// the old wording, so the ruling had reached one of the two surfaces.
//
// Counted rather than matched against the old sentence: what was wrong is that the claim is made TWICE,
// and a count stays honest when either line is reworded.
test("#682 sweep: the one-time key box claims 'only once' once, on the screen that enrols during sign-in", async ({ page }) => {
  test.setTimeout(120_000);
  const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
  await page.route("**/api/auth/local/login", (r) => r.fulfill(json({ ok: false, factor: "enrolment-required" })));
  await page.route("**/api/auth/local/factor/enrol", (r) =>
    r.fulfill(json({ factorId: "f-682", secret: "JBSWY3DPEHPK3PXP", uri: "otpauth://totp/W:a?secret=JBSWY3DPEHPK3PXP" }, 201)));

  // #605's break-glass screen, which always renders the password form (the fixture tenant has not
  // selected password sign-in, so /login hides it) — the same door `factor-interstitial-652` uses.
  await page.goto("/login/recovery");
  await expect(page.getByTestId("login-local")).toBeVisible({ timeout: 20_000 });
  await page.getByTestId("login-local-identifier").fill("someone@example.test");
  await page.getByTestId("login-local-password").fill("hunter2");
  await page.getByTestId("login-local-submit").click();

  await expect(page.getByTestId("login-factor-enrol-start")).toBeVisible({ timeout: 20_000 });
  await page.getByTestId("login-factor-enrol-start").click();
  const box = page.getByTestId("login-factor-secret");
  await expect(box).toBeVisible({ timeout: 20_000 });

  // Everything the box says, minus the key itself — a base32 secret can spell anything, including the
  // word being counted.
  const prose = await box.evaluate((el) => {
    const clone = el.cloneNode(true) as HTMLElement;
    clone.querySelectorAll("code").forEach((n) => n.remove());
    return clone.innerText ?? clone.textContent ?? "";
  });
  const claims = (prose.match(/only once|shown once|一度しか/gi) ?? []).length;
  expect(claims, `the box says the key is shown once ${claims} times:\n${prose}`).toBe(1);
  // …and the premise: it says it at all. A box that lost the warning entirely would otherwise read as
  // a fix.
  expect(claims, "the box no longer warns that the key is shown once").toBeGreaterThan(0);
});
