import { test, expect } from "@playwright/test";

// #580: the create form asks which KIND of role first, and shows only that scope's capabilities.
//
// #536 removed a scope <Select> nobody could find and derived the scope from the ticked boxes; the
// user then hit the other half of the problem — with both vocabularies in one grid you cannot tell
// what you are building until you have already ticked something. Segments, visible from the start.
//
// Real Chromium because the point IS the form: what is on screen before you touch anything, and what
// the switch does to the boxes.
test("#580: the scope is chosen first, and the capability list follows it", async ({ page, request }) => {
  const name = `e2e-580-${Date.now()}`;
  await page.goto("/admin/roles");
  await expect(page.getByTestId("admin-roles")).toBeVisible({ timeout: 10_000 });
  await page.getByTestId("role-create").click();

  // the choice is READABLE without opening anything, and one side is already selected — the form
  // always says what it is building
  const segments = page.getByTestId("role-scope-segments");
  await expect(segments).toBeVisible();


  // the SELECTED segment is filled. `bg-bg-subtle` named a token @theme never defined, so the fill
  // was rgba(0,0,0,0) and "which one is chosen" came down to font weight (review finding 1).
  const fills = await page.evaluate(() => ["resource", "tenant"].map((s) =>
    getComputedStyle(document.querySelector(`[data-testid=role-scope-${s}]`)!).backgroundColor));
  expect(fills[0], `the chosen segment is painted (got ${fills.join(" / ")})`).not.toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
  expect(fills[1], "and the unchosen one is not").toMatch(/rgba\(0, 0, 0, 0\)|transparent/);

  // it says radiogroup, so it moves like one: arrows change the choice (review finding 3)
  await page.getByTestId("role-scope-resource").focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByTestId("role-scope-tenant"), "ArrowRight moves to the other segment").toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("role-cap-createSpaces"), "and the capability list follows the keyboard too").toBeVisible();
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByTestId("role-scope-resource")).toHaveAttribute("aria-checked", "true");
  // roving tabindex: only the chosen segment is a tab stop
  expect(await page.getByTestId("role-scope-tenant").getAttribute("tabindex"), "the unchosen segment is out of the tab order").toBe("-1");
  await expect(page.getByTestId("role-scope-resource")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("role-scope-tenant")).toHaveAttribute("aria-checked", "false");

  // space/page vocabulary only
  await expect(page.getByTestId("role-cap-view")).toBeVisible();
  await expect(page.getByTestId("role-cap-createSpaces"), "the other scope's words are not on screen").toHaveCount(0);

  // switching swaps the whole vocabulary — this is what makes a mixed role unbuildable
  await page.getByTestId("role-scope-tenant").click();
  await expect(page.getByTestId("role-scope-tenant")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("role-cap-createSpaces")).toBeVisible();
  await expect(page.getByTestId("role-cap-view")).toHaveCount(0);
  await expect(page.getByTestId("role-cap-issueApiKeys")).toBeVisible();

  // a tick does not survive the switch: keeping it would rebuild the mix this removes
  await page.getByTestId("role-cap-createSpaces").check();
  await page.getByTestId("role-scope-resource").click();
  await page.getByTestId("role-scope-tenant").click();
  await expect(page.getByTestId("role-cap-createSpaces")).not.toBeChecked();

  // and it saves as a TENANT role — the segment is what decides, no derivation
  await page.getByTestId("role-name-input").fill(name);
  await page.getByTestId("role-cap-issueApiKeys").check();
  await page.getByTestId("role-save").click();
  const row = page.getByTestId("custom-role-row").filter({ hasText: name });
  await expect(row).toBeVisible({ timeout: 8000 });
  // it landed in the tenant section (the list's own scope split, #536④ — non-regression)
  const tenantList = page.getByTestId("roles-list-tenant");
  await expect(tenantList.getByTestId("custom-role-row").filter({ hasText: name })).toBeVisible();

  // TWO LAYERS: the UI cannot compose a mix, and the server refuses one anyway (#445/ADR-171)
  const mixed = await request.post("/api/admin/roles", {
    headers: { authorization: "Bearer dev-token", "content-type": "application/json" },
    data: { name: `${name}-mixed`, capabilities: ["view", "createSpaces"], scope: "tenant" },
  });
  expect(mixed.status(), "the API is the fortress, not the form").toBe(400);

  // clean up
  const list = await request.get("/api/admin/roles", { headers: { authorization: "Bearer dev-token" } });
  const created = ((await list.json()).custom as { id: string; name: string }[]).find((r) => r.name === name);
  if (created) await request.delete(`/api/admin/roles/${created.id}`, { headers: { authorization: "Bearer dev-token" } });
});

// #580 review 2, as its own case because it needs a page TALLER than the window — which is what
// the reviewer had (existing roles pushed "create a role" to y≈704 of a 720px viewport, and the form
// opened below the fold at top=759). The first version of this assertion lived in the test above and
// was VACUOUS: the e2e tenant has few roles, so the form was on screen with or without the fix. Here
// the window is short enough that the trigger is genuinely at the bottom, and removing the
// scrollIntoView turns this red.
test("#580: opening the form puts it where you can read it", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 380 });
  await page.goto("/admin/roles");
  await expect(page.getByTestId("admin-roles")).toBeVisible({ timeout: 10_000 });

  // put the trigger at the BOTTOM edge, which is the state the reviewer had (a long roles list pushes
  // it there). scrollIntoViewIfNeeded lands it mid-window, where even an unscrolled form fits — that
  // is exactly how the first version of this pin managed to pass without the fix.
  const trigger = page.getByTestId("role-create");
  const before = await page.evaluate(() => {
    const el = document.querySelector("[data-testid=role-create]") as HTMLElement;
    let scroller: HTMLElement = document.scrollingElement as HTMLElement;
    for (let p = el.parentElement; p; p = p.parentElement) {
      const st = getComputedStyle(p);
      if (/(auto|scroll)/.test(st.overflowY) && p.scrollHeight > p.clientHeight) { scroller = p; break; }
    }
    const r = el.getBoundingClientRect();
    scroller.scrollTop += r.top - (window.innerHeight - r.height - 8);
    const after = el.getBoundingClientRect();
    return { trigger: Math.round(after.top), h: window.innerHeight };
  });
  // the fixture is only meaningful if the trigger really is near the bottom edge
  expect(before.trigger, `the trigger sits at the bottom edge: ${JSON.stringify(before)}`).toBeGreaterThan(before.h - 60);

  await trigger.click();
  await expect(page.getByTestId("role-scope-segments")).toBeVisible();
  const box = await page.evaluate(() => {
    const r = document.querySelector("[data-testid=role-scope-segments]")!.getBoundingClientRect();
    const n = document.querySelector("[data-testid=role-name-input]")!.getBoundingClientRect();
    return { segTop: Math.round(r.top), segBottom: Math.round(r.bottom), nameTop: Math.round(n.top), h: window.innerHeight };
  });
  expect(box.segTop >= 0 && box.segBottom <= box.h, `the scope choice is inside the window: ${JSON.stringify(box)}`).toBe(true);
  expect(box.nameTop >= 0, "and so is the field above it").toBe(true);
});
