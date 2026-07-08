import { test, expect } from "@playwright/test";

// #245 / ADR-112: a space share-link guest browses the linked space in the REAL sidebar (page tree),
// read-only, with NO member chrome (no new-page/settings/space-switcher). The tree lists only FGA-viewable
// pages; clicking one opens it in the content area. Real Chromium. The share link is minted via the API
// (space links are view-only) so the test is deterministic.
const API = "http://dev.localhost:4010";
const H = { Authorization: "Bearer dev-token", "content-type": "application/json", host: "dev.localhost" };

test("#245: space-link guest gets the sidebar tree, no member chrome, opens a page", async ({ browser }) => {
  // Find a space that has at least one guest-listable (published) page.
  const spaces = (await (await fetch(`${API}/spaces`, { headers: H })).json()) as { id: string }[];
  let spaceId = "";
  for (const s of spaces) {
    const pages = (await (await fetch(`${API}/spaces/${s.id}/pages`, { headers: H })).json()) as { id: string }[];
    if (pages.length > 0) { spaceId = s.id; break; }
  }
  expect(spaceId, "a space with pages exists").toBeTruthy();

  // Mint a SPACE view link via the API.
  const link = (await (await fetch(`${API}/share-links`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ resource: { type: "space", id: spaceId }, capability: "view" }),
  }).then((r) => r.json())) as { id: string });
  expect(link.id).toBeTruthy();

  const guest = await (await browser.newContext()).newPage();
  await guest.goto(`/share/${link.id}`);

  // The guest reader-chrome sidebar renders the page tree.
  await expect(guest.getByTestId("guest-sidebar")).toBeVisible({ timeout: 10000 });
  const rows = guest.getByTestId("guest-tree-page");
  await expect(rows.first()).toBeVisible({ timeout: 10000 });

  // NO member chrome: the new-page / space-switcher / settings affordances never render for a guest.
  await expect(guest.getByTestId("new-page")).toHaveCount(0);
  await expect(guest.getByTestId("new-page-from-template")).toHaveCount(0);
  await expect(guest.getByTestId("space-settings-open")).toHaveCount(0);

  // Clicking a page opens it in the content area (the read-only editor surface).
  await rows.first().click();
  await expect(guest.locator("[data-pane=preview] .cm-content")).toBeVisible({ timeout: 10000 });
});
