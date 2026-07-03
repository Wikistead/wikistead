import { test, expect } from "@playwright/test";
import { openDemo, sleep } from "../helpers";

// Phase 5c: space branding accent cascade. Picking a space accent overrides the
// --accent token (inline on :root, beating the stylesheet default) while the
// personal light/dark base (--bg/--fg) is never touched (orthogonality). Inherit
// clears the override. dev-user manages demo_space, so the Theme tab is reachable.
const accentVar = () => document.documentElement.style.getPropertyValue("--accent").trim();
const bgVar = () => document.documentElement.style.getPropertyValue("--bg").trim();

// #201: accent is now PERSONAL (device-local, like light/dark) — a user picks their own accent that
// overrides the tenant accent for them only. Spaces no longer carry an accent. The personal light/dark
// base (--bg/--fg) is never touched; the "Default" chip clears the personal override (inherit tenant).
test("personal accent overrides --accent inline and leaves --bg untouched; default chip clears it (#201)", async ({ page }) => {
  await openDemo(page);
  await page.goto("/settings/account/theme");
  await expect(page.getByTestId("account-theme")).toBeVisible();

  // Pick violet → applied inline on :root (personal override).
  await page.getByTestId("accent-violet").click();
  await expect.poll(() => page.evaluate(accentVar)).toMatch(/^#(7c3aed|a78bfa)$/); // light|dark violet
  // Orthogonality: only --accent/--accent-fg are overridden, never --bg.
  expect(await page.evaluate(bgVar)).toBe("");

  // "Default (match workspace)" clears the personal override → inherit the tenant accent.
  await page.getByTestId("accent-inherit").click();
  await sleep(100);
});

// Phase 5d: tenant branding (admin) — the cascade root + header wordmark. Resets
// to default at the end so it doesn't leak into other specs (branding persists).
test("tenant branding: name shows in the header and accent applies app-wide; reset", async ({ page }) => {
  await openDemo(page);
  await page.goto("/admin/branding");
  await expect(page.getByTestId("tenant-branding")).toBeVisible();

  await page.getByTestId("tenant-name-input").fill("Acme Wiki");
  await page.getByTestId("tenant-name-save").click();
  await expect.poll(() => page.getByTestId("brand").textContent()).toBe("Acme Wiki");

  await page.getByTestId("accent-rose").click();
  await expect.poll(() => page.evaluate(accentVar)).toMatch(/^#(e11d48|fb7185)$/); // light|dark rose
  expect(await page.evaluate(bgVar)).toBe(""); // personal base untouched
  // #201: the tenant picker has NO inherit chip — the tenant is the top of the cascade (always a
  // concrete colour). Reset the accent by picking the default blue, and clear the name.
  await page.getByTestId("accent-blue").click();
  await page.getByTestId("tenant-name-input").fill("");
  await page.getByTestId("tenant-name-save").click();
  await expect.poll(() => page.getByTestId("brand").textContent()).toBe("Wikistead");
});

// Phase 5d-2: tenant logo (base64 upload, no new dependency). A 1x1 PNG is enough —
// the server validates magic bytes + size; the header swaps the wordmark for the
// logo. Resets at the end so it doesn't leak into other specs.
const PNG_1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

test("tenant logo: logo and name are two INDEPENDENT slots, each with a default; neither hides the other (#143)", async ({ page }) => {
  await openDemo(page);
  await page.goto("/admin/branding");
  await expect(page.getByTestId("tenant-branding")).toBeVisible();

  // #143 regression this captures: the header used to be EXCLUSIVE — uploading a logo hid the name,
  // and the name hid the default logo — so only one element ever showed. The fix makes the header two
  // always-present, independent slots: a LOGO slot (custom img ▷ default Wikistead mark) and a NAME
  // slot (display name ▷ "Wikistead"). Setting one never empties the other.

  // Baseline (no custom logo, no name): the DEFAULT mark fills the logo slot AND the name slot shows.
  // Both slots are populated by their defaults — the header is never a single lonely element.
  await expect(page.getByTestId("brand-mark")).toBeVisible(); // default logo present
  await expect(page.getByTestId("brand")).toBeVisible();      // name slot present ("Wikistead")
  await expect(page.getByTestId("brand-logo")).toHaveCount(0); // no CUSTOM logo yet

  await page.getByTestId("tenant-logo-input").setInputFiles({
    name: "logo.png", mimeType: "image/png", buffer: Buffer.from(PNG_1x1, "base64"),
  });
  // Uploading a custom logo swaps the LOGO slot (default mark → custom img) but leaves the NAME slot.
  await expect(page.getByTestId("brand-logo")).toBeVisible();  // custom logo now in the logo slot
  await expect(page.getByTestId("brand-mark")).toHaveCount(0); // default mark gave way to the custom one
  await expect(page.getByTestId("brand")).toBeVisible();       // name slot UNAFFECTED (was: erased)

  await page.getByTestId("tenant-logo-remove").click();
  // Removing the custom logo restores the DEFAULT mark in the logo slot; the name slot is still there.
  await expect(page.getByTestId("brand-logo")).toHaveCount(0); // custom logo gone
  await expect(page.getByTestId("brand-mark")).toBeVisible();  // default mark restored (slot never empties)
  await expect(page.getByTestId("brand")).toBeVisible();       // name remains (independent)
});
