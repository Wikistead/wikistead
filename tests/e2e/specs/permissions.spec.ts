import { test, expect } from "@playwright/test";
import { openDemo, sleep, API, DEV_USER_SHOWN } from "../helpers";

// Phase 4c: the per-page Permissions dialog (manager only). Grant a member access
// (this is also how you invite someone to a draft) and revoke it.
test("manager grants and revokes page access via the Permissions dialog", async ({ page }) => {
  await openDemo(page);
  const pageId = await page.evaluate(async (api) => {
    const r = await fetch(`${api}/spaces/demo_space/pages`, {
      method: "POST",
      headers: { Authorization: "Bearer dev-token", "content-type": "application/json" },
      body: JSON.stringify({ title: "perms page" }),
    });
    return (await r.json()).id as string;
  }, API);

  await page.goto(`/p/${pageId}`);
  await page.waitForSelector("[data-pane=preview] .cm-content");
  // the creator (dev-user) has manage → Permissions is offered in the ••• menu
  await page.click("[data-testid=page-overflow-trigger]");
  await page.click("[data-testid=permissions-open]");
  await expect(page.locator("[data-testid=permissions-dialog]")).toBeVisible();

  // the creator's own grant is listed
  await expect(page.locator("[data-testid=grant-list]")).toContainText(DEV_USER_SHOWN); // #902

  // Grant a member view → a row appears.
  //
  // PICKED from the suggestions, not typed. This spec used to fill `alice-perm` — a sub belonging to
  // nobody — and press Add, and #624 closed that from both ends: the server answers 400 `not_a_member`
  // (a grant to a stranger leaves a tuple no one can ever hold), and this dialog now sends
  // `pickedGrant?.grantee ?? null` — "chosen candidate only". Typing alone picks nobody, so Add sent
  // nothing and the list never grew. The fixture was driving a field that had stopped being an input.
  //
  // COUNTED, not matched by text: the row is labelled by whatever the server could resolve for that
  // sub, and failing that "unknown member", because #578 keeps the subject id off this screen. There is
  // no string to know in advance — what there is, is one more row than before.
  const rows = page.locator("[data-testid=grant-item]");
  const before = await rows.count();
  const serverGrants = async () => page.evaluate(async ({ api, pageId }) =>
    ((await (await fetch(`${api}/pages/${pageId}/access`, { headers: { Authorization: "Bearer dev-token" } })).json()) as { grantee: string }[]).length,
    { api: API, pageId });
  const grantsBefore = await serverGrants();

  await page.fill("[data-testid=grant-sub]", "d"); // the seeded subs the picker can offer for this page
  await expect(page.getByTestId("grant-candidates")).toBeVisible({ timeout: 8000 });
  await page.getByTestId("grant-candidate").first().click();
  await page.getByTestId("grant-relation").click();
  // #582: the picker's values carry their MECHANISM as a prefix (`builtin:` vs `role:`), so a custom
  // role named `edit` can never be taken for the capability. The option id follows the value.
  await page.getByTestId("grant-relation-builtin:view").click();
  await page.click("[data-testid=grant-add]");
  await expect(rows).toHaveCount(before + 1);
  // …and the SERVER holds it — the half a row count cannot show
  await expect.poll(serverGrants, { timeout: 8000 }).toBe(grantsBefore + 1);

  // revoke → the row goes, and so does the tuple
  await rows.nth(before).locator("[data-testid=grant-revoke]").click();
  await expect(rows).toHaveCount(before);
  await sleep(200);
  expect(await serverGrants()).toBe(grantsBefore);
});

// #109 / ADR-098: the PRIVATE (allowlist) toggle in the Permissions dialog. Turning it on makes the
// page private on the server (only the allow list can access); turning it off clears it. Verified in a
// real browser against the e2e server.
test("manager toggles a page private (allowlist) via the Permissions dialog", async ({ page }) => {
  await openDemo(page);
  const pageId = await page.evaluate(async (api) => {
    const r = await fetch(`${api}/spaces/demo_space/pages`, {
      method: "POST",
      headers: { Authorization: "Bearer dev-token", "content-type": "application/json" },
      body: JSON.stringify({ title: "private page" }),
    });
    return (await r.json()).id as string;
  }, API);

  await page.goto(`/p/${pageId}`);
  await page.waitForSelector("[data-pane=preview] .cm-content");
  await page.click("[data-testid=page-overflow-trigger]");
  await page.click("[data-testid=permissions-open]");
  await expect(page.locator("[data-testid=permissions-dialog]")).toBeVisible();

  const toggle = page.locator("[data-testid=private-toggle]");
  await expect(toggle).not.toBeChecked(); // starts non-private

  const isPrivate = async () => page.evaluate(async ({ api, pageId }) =>
    (await (await fetch(`${api}/pages/${pageId}/private`, { headers: { Authorization: "Bearer dev-token" } })).json()).private as boolean,
    { api: API, pageId });

  // turn private ON → #109 Fix A: a confirm dialog warns first (privatising revokes share links, one-way).
  await toggle.click();
  await expect(page.locator("[data-testid=private-confirm]")).toBeVisible();
  await page.locator("[data-testid=private-confirm]").click();
  // Confirming applies the mutation (the dialog closes on the destructive confirm) — private is now set.
  await expect.poll(isPrivate).toBe(true);

  // #109 Fix B: a lock badge appears next to the title and in the sidebar tree once private.
  await expect(page.locator("[data-testid=title-private-lock]")).toBeVisible();
  await expect(page.locator("[data-testid=tree-private-lock]")).toHaveCount(1);

  // Reopen and turn private OFF → a plain toggle (no confirm); server clears it, lock disappears.
  await page.click("[data-testid=page-overflow-trigger]");
  await page.click("[data-testid=permissions-open]");
  await expect(toggle).toBeChecked();
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  expect(await isPrivate()).toBe(false);
  await expect(page.locator("[data-testid=title-private-lock]")).toHaveCount(0);
});

// #109 Fix A: privatising a page with an active share link warns with the count and revokes it.
test("privatising a page revokes its share links (confirm shows count)", async ({ page }) => {
  await openDemo(page);
  const pageId = await page.evaluate(async (api) => {
    const r = await fetch(`${api}/spaces/demo_space/pages`, {
      method: "POST",
      headers: { Authorization: "Bearer dev-token", "content-type": "application/json" },
      body: JSON.stringify({ title: "shared then private" }),
    });
    return (await r.json()).id as string;
  }, API);

  // Create a page share link up front (guestAccess is a paid entitlement; the demo tenant has it).
  const linkCount = async () => page.evaluate(async ({ api, pageId }) =>
    ((await (await fetch(`${api}/pages/${pageId}/share-links`, { headers: { Authorization: "Bearer dev-token" } })).json()) ?? []).length as number,
    { api: API, pageId });
  await page.evaluate(async ({ api, pageId }) => {
    await fetch(`${api}/share-links`, {
      method: "POST",
      headers: { Authorization: "Bearer dev-token", "content-type": "application/json" },
      body: JSON.stringify({ resource: { type: "page", id: pageId }, capability: "view" }),
    });
  }, { api: API, pageId });
  expect(await linkCount()).toBe(1);

  await page.goto(`/p/${pageId}`);
  await page.waitForSelector("[data-pane=preview] .cm-content");
  await page.click("[data-testid=page-overflow-trigger]");
  await page.click("[data-testid=permissions-open]");
  await page.locator("[data-testid=private-toggle]").click();
  // The confirm body names the active link count (1) — the manager sees what will be lost.
  await expect(page.locator("[data-testid=confirm-dialog]")).toContainText("1");
  await page.locator("[data-testid=private-confirm]").click();

  // The share link is gone (one-way) — count drops to 0, and the page is now private.
  await expect.poll(linkCount).toBe(0);
  expect(await page.evaluate(async ({ api, pageId }) =>
    (await (await fetch(`${api}/pages/${pageId}/private`, { headers: { Authorization: "Bearer dev-token" } })).json()).private as boolean,
    { api: API, pageId })).toBe(true);
});
