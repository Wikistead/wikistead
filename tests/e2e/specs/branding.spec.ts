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
