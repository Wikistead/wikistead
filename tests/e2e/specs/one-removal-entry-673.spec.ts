import { test, expect, type Page } from "@playwright/test";
import { openDemo, sleep } from "../helpers";

// #673 ①: the way to remove a factor is the SAME in every row, whatever that row holds.
//
// The ticket asked for this in a specific form: do NOT write a pin that enumerates the kinds — it
// cannot hold once factors beyond passkeys arrive. The assertions that landed with the fix are
// per-kind — one file says a passkey row
// carries `factor-remove`, another says a TOTP row opens a code box — and both stay green on the day a
// third kind arrives wearing its own control. That is the artefact the ticket named.
//
// So this compares ROWS AGAINST EACH OTHER instead of against a list of kinds. It reads the controls
// every row actually renders and requires the sets to be identical. It does not know what a passkey is.
//
// GET /me/factors is stubbed, the #537 pattern: the point is to put unlike rows side by side, and the
// dev tenant cannot be made to hold a passkey and an authenticator at once without a real ceremony
// (which `passkey-lifecycle-666` already drives). Nothing here writes.
const FACTORS = {
  factors: [
    { id: "f-totp", kind: "totp", label: "Phone", createdAt: "2026-01-01T00:00:00Z", confirmedAt: "2026-01-01T00:00:00Z", lastUsedAt: null, counts: true },
    { id: "f-key", kind: "passkey", label: "YubiKey", createdAt: "2026-01-02T00:00:00Z", confirmedAt: "2026-01-02T00:00:00Z", lastUsedAt: null, counts: true },
    // A kind this build has never heard of. The product will not mint one — the point is that the
    // SHAPE of the row cannot depend on the kind, so an unknown one must look like the others. If a
    // future kind is given its own control, that is where this test earns its keep.
    { id: "f-future", kind: "smartcard", label: "Company card", createdAt: "2026-01-03T00:00:00Z", confirmedAt: "2026-01-03T00:00:00Z", lastUsedAt: null, counts: true },
    // …and an unconfirmed one, which IS allowed to differ in what it asks for after the click (#660
    // possession is only proved for something that guards anything) but not in how it is reached.
    { id: "f-pending", kind: "totp", label: "Half done", createdAt: "2026-01-04T00:00:00Z", confirmedAt: null, lastUsedAt: null, counts: false },
  ],
  stance: "any",
};

async function openSecurity(page: Page) {
  await page.route((url) => url.pathname === "/api/me/factors", (route) =>
    route.request().method() === "GET"
      ? route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(FACTORS) })
      : route.fallback());
  await openDemo(page);
  await page.goto("/settings/account/security");
  await expect(page.getByTestId("second-factor-panel")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('[data-testid="factor-row"]')).toHaveCount(FACTORS.factors.length, { timeout: 15_000 });
  await sleep(200);
}

/**
 * The interactive controls a row offers, as a set of testids.
 *
 * Read off the DOM rather than named here: a control this test does not know about still shows up, and
 * that is the whole point — the failure being guarded against is somebody ADDING one for a kind.
 */
const controlsOf = (page: Page, i: number) =>
  page.locator('[data-testid="factor-row"]').nth(i)
    .locator("[data-testid]")
    .evaluateAll((els) => [...new Set(els.map((e) => e.getAttribute("data-testid") ?? ""))]
      .filter((t) => t && t !== "factor-row").sort());

test("#673: every row offers the same controls, whatever kind it holds", async ({ page }) => {
  test.setTimeout(120_000);
  await openSecurity(page);

  const sets = await Promise.all(FACTORS.factors.map((_, i) => controlsOf(page, i)));
  const names = FACTORS.factors.map((f) => `${f.label} (${f.kind}${f.confirmedAt ? "" : ", unconfirmed"})`);

  // The unconfirmed row wears a mark the others do not — that is a STATUS, not a control, and it is
  // #653's answer to a different problem. `factor-kind-mark` (#653) is the same: it says WHAT the
  // row is, and it is absent from an unnamed row on purpose (there the name already is the kind), so
  // counting it here would call that legitimate difference an inconsistent way in. Everything else must
  // match.
  const STATUS = new Set(["factor-label", "factor-pending-mark", "factor-kind-mark"]);
  const controls = sets.map((s) => s.filter((t) => !STATUS.has(t)));

  const first = controls[0]!;
  for (let i = 1; i < controls.length; i++) {
    expect(controls[i], `${names[i]} offers different controls from ${names[0]}\n  ${names[0]}: ${first.join(", ")}\n  ${names[i]}: ${controls[i]!.join(", ")}`)
      .toEqual(first);
  }

  // …and the premise: the rows really are unlike each other, so the equality above is a finding rather
  // than a tautology about four copies of one row.
  const kinds = new Set(FACTORS.factors.map((f) => f.kind));
  expect(kinds.size, "the fixture stopped putting unlike rows side by side").toBeGreaterThan(2);
  // The control they share is the removal one — named, so that "every row offers nothing" cannot pass.
  expect(first, "no row offers a way to remove the factor at all").toContain("factor-remove");
});

test("#673: what the click asks for may differ; what you click must not", async ({ page }) => {
  test.setTimeout(120_000);
  await openSecurity(page);

  // The other half of the ruling. The kind decides the PROOF — a code to type, or the key itself — and
  // that difference is legitimate. It just belongs after the click. Measured on the two kinds this
  // build actually implements, because a proof is a real interaction rather than a shape.
  const rows = page.locator('[data-testid="factor-row"]');
  const totpRow = rows.filter({ hasText: "Phone" }).first();
  const keyRow = rows.filter({ hasText: "YubiKey" }).first();

  await totpRow.getByTestId("factor-remove").click();
  await expect(totpRow.getByTestId("factor-remove-code"), "an authenticator app asks for a code, in the row")
    .toBeVisible({ timeout: 10_000 });
  // leave that state before touching the other row
  await totpRow.getByRole("button", { name: /cancel|キャンセル/i }).click();
  await expect(totpRow.getByTestId("factor-remove-code")).toHaveCount(0, { timeout: 10_000 });

  await keyRow.getByTestId("factor-remove").click();
  await expect(keyRow.getByTestId("factor-remove-code"), "a passkey has no code to type — it signs instead")
    .toHaveCount(0);
});
