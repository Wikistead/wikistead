import { test, expect } from "@playwright/test";
import { openDemo, sleep } from "../helpers";

// Phase 5c: space branding accent cascade. Picking a space accent overrides the
// --accent token (inline on :root, beating the stylesheet default) while the
// personal light/dark base (--bg/--fg) is never touched (orthogonality). Inherit
// clears the override. dev-user manages demo_space, so the Theme tab is reachable.
const accentVar = () => document.documentElement.style.getPropertyValue("--accent").trim();
const bgVar = () => document.documentElement.style.getPropertyValue("--bg").trim();

test("space accent overrides --accent inline and leaves --bg untouched; inherit clears it", async ({ page }) => {
  await openDemo(page);
  await page.goto("/spaces/demo_space/settings/theme");
  await expect(page.getByTestId("space-theme")).toBeVisible();

  // No inline accent override before a choice; --bg is owned by the personal theme.
  expect(await page.evaluate(bgVar)).toBe("");

  // Pick violet → the cascade applies it inline on :root.
  await page.getByTestId("accent-violet").click();
  await expect.poll(() => page.evaluate(accentVar)).toMatch(/^#(7c3aed|a78bfa)$/); // light|dark violet
  // Orthogonality: only --accent/--accent-fg are overridden, never --bg.
  expect(await page.evaluate(bgVar)).toBe("");

  // Inherit clears the override (reverts to the default token).
  await page.getByTestId("accent-inherit").click();
  await expect.poll(() => page.evaluate(accentVar)).toBe("");

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

  // Reset: accent → default, name → empty (header back to the product wordmark).
  await page.getByTestId("accent-inherit").click();
  await expect.poll(() => page.evaluate(accentVar)).toBe("");
  await page.getByTestId("tenant-name-input").fill("");
  await page.getByTestId("tenant-name-save").click();
  await expect.poll(() => page.getByTestId("brand").textContent()).toBe("Wikistead");
});

// Phase 5d-2: tenant logo (base64 upload, no new dependency). A 1x1 PNG is enough —
// the server validates magic bytes + size; the header swaps the wordmark for the
// logo. Resets at the end so it doesn't leak into other specs.
const PNG_1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

test("tenant logo: upload shows the logo in the header; remove reverts to the wordmark", async ({ page }) => {
  await openDemo(page);
  await page.goto("/admin/branding");
  await expect(page.getByTestId("tenant-branding")).toBeVisible();

  await page.getByTestId("tenant-logo-input").setInputFiles({
    name: "logo.png", mimeType: "image/png", buffer: Buffer.from(PNG_1x1, "base64"),
  });
  await expect(page.getByTestId("brand-logo")).toBeVisible();
  await expect(page.getByTestId("brand")).toHaveCount(0); // wordmark replaced

  await page.getByTestId("tenant-logo-remove").click();
  await expect(page.getByTestId("brand")).toBeVisible(); // wordmark back
  await expect(page.getByTestId("brand-logo")).toHaveCount(0);
});
