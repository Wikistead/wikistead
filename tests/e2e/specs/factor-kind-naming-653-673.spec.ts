import { test, expect, type Page } from "@playwright/test";
import { openDemo, sleep } from "../helpers";

// #653 / #673 a row, and every sentence about it, says WHICH KIND it is.
//
// The defect was one noun standing in for all of them. A passkey enrolled without a name sat in the
// list calling itself an authenticator app; removing one said "Authenticator removed."; adding one said
// "Authenticator added." Three sentences, one blind spot — the list mixes kinds by design, so the noun
// has to come from the row rather than from when the sentence was written.
//
// The assertions below do NOT spell the nouns out. A pin that says the passkey row reads "Passkey" is
// green the day somebody reworders it and says nothing about the two kinds still sharing a word, which
// is the actual failure. What is required instead is that the kinds NAME THEMSELVES DIFFERENTLY, and
// that a kind this build has never heard of borrows neither name. That survives translation, and it
// goes red for the single-key fallback that shipped.
//
// GET /me/factors is stubbed (the #537 pattern, as `one-removal-entry-673` does): the point is unlike
// rows side by side, including an unnamed one of each kind, which no real ceremony will produce.

const UNNAMED = { label: "", createdAt: "2026-01-01T00:00:00Z", lastUsedAt: null, counts: true };
const FACTORS = {
  factors: [
    { ...UNNAMED, id: "u-totp", kind: "totp", confirmedAt: "2026-01-01T00:00:00Z" },
    { ...UNNAMED, id: "u-key", kind: "passkey", confirmedAt: "2026-01-01T00:00:00Z" },
    // A kind this build does not implement. It must not be given one of the real names — defaulting to
    // a real kind is the very defect here: correct today, quietly wrong the day the server grows one.
    { ...UNNAMED, id: "u-future", kind: "smartcard", confirmedAt: "2026-01-01T00:00:00Z" },
    { ...UNNAMED, id: "n-key", kind: "passkey", label: "YubiKey", confirmedAt: "2026-01-01T00:00:00Z" },
    // Unconfirmed, so removal takes the plain path — no browser ceremony, which is what lets the
    // REMOVAL SENTENCE be read here at all. It is also the branch that has to carry the kind with the
    // id, since it serves every kind.
    // Labels with no shared prefix: `hasText` is a SUBSTRING match, so "Half done" and "Half done too"
    // would both answer to the first of them and the two rows below would be the same row.
    { ...UNNAMED, id: "p-key", kind: "passkey", label: "Unfinished key", confirmedAt: null, counts: false },
    { ...UNNAMED, id: "p-totp", kind: "totp", label: "Started app", confirmedAt: null, counts: false },
  ],
  stance: "any",
};

async function openSecurity(page: Page, lang: "en" | "ja") {
  await page.addInitScript((l) => localStorage.setItem("wks.lang", l as string), lang);
  await page.route((url) => url.pathname === "/api/me/factors", (route) =>
    route.request().method() === "GET"
      ? route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(FACTORS) })
      : route.fallback());
  await openDemo(page);
  await page.goto("/settings/account/security");
  await expect(page.getByTestId("second-factor-panel")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('[data-testid="factor-row"]')).toHaveCount(FACTORS.factors.length, { timeout: 15_000 });
  await expect(page.locator('html')).toHaveAttribute("lang", lang);
  await sleep(200);
}

/** What row `i` calls itself — the name only, without the status marks that sit beside it. */
const nameOf = async (page: Page, i: number) => {
  const row = page.locator('[data-testid="factor-row"]').nth(i);
  return (await row.getByTestId("factor-label").evaluate((el) => {
    const clone = el.cloneNode(true) as HTMLElement;
    clone.querySelectorAll("[data-testid]").forEach((n) => n.remove());
    return clone.textContent ?? "";
  })).trim();
};

for (const lang of ["en", "ja"] as const) {
  test(`#653: an unnamed row is named by its kind, and no two kinds share the name (${lang})`, async ({ page }) => {
    test.setTimeout(120_000);
    await openSecurity(page, lang);

    const [totp, key, future] = [await nameOf(page, 0), await nameOf(page, 1), await nameOf(page, 2)];

    // The reported bug, stated exactly: a passkey with no label wore the authenticator app's name.
    expect(key, `an unnamed passkey is calling itself what the authenticator app is called (${totp})`)
      .not.toBe(totp);
    // …and neither of them is empty, which "not equal" alone would tolerate.
    expect(totp.length, "an unnamed authenticator app has no name at all").toBeGreaterThan(0);
    expect(key.length, "an unnamed passkey has no name at all").toBeGreaterThan(0);

    // A kind the build has never seen borrows nobody's name. This is the clause that keeps the fix from
    // being a second hard-coded pair: a fallback that picks one of the two real kinds passes the two
    // assertions above and still lies about the third.
    expect([totp, key], `an unknown kind is impersonating another one (${future})`).not.toContain(future);
    expect(future.length, "an unknown kind has no name at all").toBeGreaterThan(0);
  });

  test(`#653: a row WITH a name still says which kind it is, and an unnamed one does not say it twice (${lang})`, async ({ page }) => {
    test.setTimeout(120_000);
    await openSecurity(page, lang);

    // asked whether to mark the kind on named rows. It is answered yes here: the list mixes kinds
    // on purpose, so "YubiKey" is otherwise unreadable as to which it is — at exactly the moment that
    // matters, when choosing which one to give up.
    const named = page.locator('[data-testid="factor-row"]').filter({ hasText: "YubiKey" }).first();
    await expect(named.getByTestId("factor-kind-mark"), "a named row does not say which kind it is").toHaveCount(1);
    // …and it is the SAME noun the unnamed row of that kind uses. Two spellings of one kind is how this
    // panel has twice grown a second vocabulary.
    expect((await named.getByTestId("factor-kind-mark").textContent())?.trim()).toBe(await nameOf(page, 1));

    // The unnamed row must NOT carry it: its name already is the kind, and saying it twice in one row
    // is the duplication ③ made this same panel remove.
    const unnamed = page.locator('[data-testid="factor-row"]').nth(1);
    await expect(unnamed.getByTestId("factor-kind-mark"), "an unnamed row says its kind twice").toHaveCount(0);
  });

  test(`#673: the removal sentence names the kind that was removed (${lang})`, async ({ page }) => {
    test.setTimeout(120_000);
    await openSecurity(page, lang);
    // The unconfirmed rows go without a ceremony (#660: possession is proved only for something that
    // guards anything), so the DELETE is the whole interaction and the toast can be read.
    await page.route((url) => /^\/api\/me\/factors\/[^/]+$/.test(url.pathname), (route) =>
      route.request().method() === "DELETE" ? route.fulfill({ status: 204, body: "" }) : route.fallback());

    const say = async (rowText: string) => {
      const row = page.locator('[data-testid="factor-row"]').filter({ hasText: rowText }).first();
      await row.getByTestId("factor-remove").click();
      const toast = page.locator("[data-sonner-toast]");
      await expect(toast).toBeVisible({ timeout: 15_000 });
      // Exactly one, so that what is read below is the sentence this click produced. The page was
      // reloaded before each call precisely to leave the stack empty; if a second toast is here, the
      // reading is ambiguous and the test should say so rather than pick one.
      await expect(toast, "more than one toast is on screen — which one answered the click?").toHaveCount(1);
      const said = (await toast.textContent())?.trim() ?? "";
      await page.reload();
      await expect(page.getByTestId("second-factor-panel")).toBeVisible({ timeout: 20_000 });
      await sleep(300);
      return said;
    };

    const forKey = await say("Unfinished key");
    const forApp = await say("Started app");

    // Not the wording — the DISTINCTION. One sentence for both kinds is the defect; it is also what a
    // template that forgets to interpolate produces, and what an assertion on a single literal misses.
    expect(forKey, `removing a passkey and removing an authenticator app say the same thing: "${forKey}"`)
      .not.toBe(forApp);
    // …and each one carries its own kind's noun, so "two different sentences" cannot be satisfied by
    // two unrelated messages.
    expect(forKey, "the passkey removal does not name the passkey").toContain(await nameOf(page, 1));
    expect(forApp, "the app removal does not name the authenticator app").toContain(await nameOf(page, 0));
  });
}

test("#673 the way to remove a factor is red standing still, like every other destructive one", async ({ page }) => {
  test.setTimeout(120_000);
  await openSecurity(page, "en");

  // #504 settled that a destructive entry point wears the danger colour AT REST — "red only on hover"
  // is the thing that policy names — and `api-key-revoke` and `invite-revoke` both do. This bin was
  // grey, so the panel that had just been made to match the LIST convention (#639) was out of step with
  // the DANGER one. Compared against the token the page itself resolves, not a literal rgb: the palette
  // differs between light and dark, and a hard-coded triple pins the theme rather than the policy.
  const row = page.locator('[data-testid="factor-row"]').first();
  const danger = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--danger").trim());
  expect(danger, "the theme has no --danger token to compare against").not.toBe("");

  const [removeColour, renameColour] = await Promise.all([
    row.getByTestId("factor-remove").evaluate((el) => getComputedStyle(el).color),
    row.getByTestId("factor-rename").evaluate((el) => getComputedStyle(el).color),
  ]);
  const asRgb = async (css: string) => page.evaluate((c) => {
    const probe = document.createElement("span");
    probe.style.color = c; document.body.appendChild(probe);
    const out = getComputedStyle(probe).color; probe.remove(); return out;
  }, css);

  expect(removeColour, "the removal icon is not the danger colour at rest").toBe(await asRgb(danger));
  // The control: a row where every icon is red would satisfy the line above while saying nothing about
  // which one is destructive. Rename sits in the same row and must NOT be.
  expect(renameColour, "rename is drawn as destructively as remove").not.toBe(removeColour);
});
