import { test, expect } from "@playwright/test";

// #503: the /admin audit ledger used to render every loaded row inline, pushing the Vendor-access
// (Access Transparency) section below hundreds of rows — nobody scrolled far enough to find it. The
// ledger now scrolls INSIDE a bounded box (the #463/#406 box-scroll principle): the page keeps its own
// scroll, the box is max-h + overflow-y auto with a sticky header, and "load more" pages in-box.
// RED before the fix: the `audit-scrollbox` element did not exist at all (grep-provable on master).
test("#503: the audit ledger is a bounded scrollbox and vendor access sits right after it", async ({ page }) => {
  await page.goto("/admin/audit");
  await expect(page.getByTestId("admin-audit")).toBeVisible({ timeout: 10_000 });

  const box = page.getByTestId("audit-scrollbox");
  await expect(box).toBeVisible();
  const style = await box.evaluate((el) => {
    const s = getComputedStyle(el);
    return { maxHeight: s.maxHeight, overflowY: s.overflowY, clientHeight: el.clientHeight };
  });
  expect(style.overflowY).toBe("auto"); // internal scroll — the ledger can never grow the page
  expect(style.maxHeight).toBe("416px"); // 26rem
  expect(style.clientHeight).toBeLessThanOrEqual(418);

  // Vendor access is DISCOVERABLE: it starts right after the box (the mt-8 gap), never below an
  // unbounded ledger. (The e2e server is self-host UNLIMITED, so the section renders — empty state.)
  await expect(page.getByTestId("vendor-access")).toBeVisible();
  const boxBottom = await box.evaluate((el) => el.getBoundingClientRect().bottom);
  const vendorTop = await page.getByTestId("vendor-access").evaluate((el) => el.getBoundingClientRect().top);
  expect(vendorTop - boxBottom).toBeGreaterThanOrEqual(0);
  expect(vendorTop - boxBottom).toBeLessThan(80);
});
