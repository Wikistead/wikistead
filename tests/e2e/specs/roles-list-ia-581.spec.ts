import { test, expect } from "@playwright/test";

// #581: the roles list, read as a picture rather than as source.
//
// The user's complaint was visual: two groups whose only divider was a small grey label, every row
// repeating a scope word the group already implied, and a list that grows without bound. So the
// assertions here are geometric — a real boundary, no scope text among the rows, and a box that stops
// growing — because none of that can be judged from the markup alone.
test("#581: the two scope groups are separate surfaces, bounded, without per-row scope words", async ({ page, request }) => {
  await page.goto("/admin/roles");
  await expect(page.getByTestId("admin-roles")).toBeVisible({ timeout: 10_000 });

  // 1. a boundary that exists in the rendering, not just a heading: each group is its own panel
  const tenantBox = page.getByTestId("roles-list-tenant");
  const resourceBox = page.getByTestId("roles-list-resource");
  await expect(tenantBox).toBeVisible();
  await expect(resourceBox).toBeVisible();
  const borders = await tenantBox.evaluate((el) => {
    const card = el.closest("section")!;
    const cs = getComputedStyle(card);
    const head = card.querySelector("h3")!;
    return { cardBorder: parseFloat(cs.borderTopWidth), headBorder: parseFloat(getComputedStyle(head).borderBottomWidth) };
  });
  expect(borders.cardBorder, "the group is a surface with an edge").toBeGreaterThan(0);
  expect(borders.headBorder, "its heading is a bar, not floating text").toBeGreaterThan(0);

  // 2. no row repeats what its group already says
  await expect(page.getByTestId("roles-list").getByTestId("role-scope-badge")).toHaveCount(0);
  await expect(page.getByTestId("role-builtin-badge").first(), "BUILT-IN stays — position does not imply it").toBeVisible();

  // 3. the list stops growing: both boxes are capped and scroll internally
  for (const box of [tenantBox, resourceBox]) {
    const m = await box.evaluate((el) => ({
      maxH: parseFloat(getComputedStyle(el).maxHeight),
      overflow: getComputedStyle(el).overflowY,
      height: el.getBoundingClientRect().height,
    }));
    expect(m.overflow).toBe("auto");
    expect(m.maxH, "the same 26rem the other three lists use").toBeGreaterThan(300);
    expect(m.height).toBeLessThanOrEqual(m.maxH + 1);
  }

  // 4. enough roles to overflow → the PAGE does not grow with them; the box scrolls instead
  const made: string[] = [];
  try {
    for (let i = 0; i < 12; i++) {
      const res = await request.post("/api/admin/roles", {
        headers: { authorization: "Bearer dev-token", "content-type": "application/json" },
        data: { name: `e2e-581-${Date.now()}-${i}`, capabilities: ["view"], scope: "resource" },
      });
      if (res.status() === 201) made.push((await res.json()).id);
    }
    await page.reload();
    await expect(page.getByTestId("roles-list-resource")).toBeVisible({ timeout: 10_000 });
    const after = await resourceBox.evaluate((el) => ({
      height: el.getBoundingClientRect().height,
      maxH: parseFloat(getComputedStyle(el).maxHeight),
      scrollable: el.scrollHeight > el.clientHeight + 1,
    }));
    expect(after.height, "twelve more roles do not stretch the page").toBeLessThanOrEqual(after.maxH + 1);
    expect(after.scrollable, "they are reachable by scrolling inside the box").toBe(true);

    // non-regression: a custom row inside the box still has its live controls (scoped to the
    // space/page section — the tenant section's roles carry the other vocabulary entirely)
    const row = resourceBox.getByTestId("custom-role-row").first();
    await expect(row.getByTestId("role-delete")).toBeVisible();
    await row.scrollIntoViewIfNeeded();
    await row.getByTestId("role-edit-caps").click(); // #586 ②: the grid opens behind the edit affordance
    await expect(row.getByTestId("custom-cap-view")).toBeChecked();
  } finally {
    for (const id of made) {
      await request.delete(`/api/admin/roles/${id}`, { headers: { authorization: "Bearer dev-token" } }).catch(() => {});
    }
  }
});
