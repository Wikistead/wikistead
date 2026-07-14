import { test, expect } from "@playwright/test";
import { openDemo, enterSplit, enterEdit, resetDoc, paneText, sleep } from "../helpers";

const API = "http://dev.localhost:4010";

// #274 / ADR-135: the SPACE edit share-link — one link makes every published, non-private page in the
// space anonymously editable (the wiki use case). End to end in real Chromium: a member mints the
// space+edit link (the old view-only 400 is gone), an anonymous guest opens it, gets the guest shell
// with the space tree, opens the demo page, and CO-EDITS it live with the member.
test("#274: a space EDIT link lets an anonymous guest edit a published page in the space", async ({ browser }) => {
  const member = await (await browser.newContext()).newPage();
  await openDemo(member);
  await enterSplit(member);
  await resetDoc(member);

  // mint the space edit link via the API (dev-token member; the ShareDialog UI path is pinned by share.spec).
  const link = await member.evaluate(async (api) => {
    const res = await fetch(`${api}/share-links`, {
      method: "POST",
      headers: { Authorization: "Bearer dev-token", "Content-Type": "application/json" },
      body: JSON.stringify({ resource: { type: "space", id: "demo_space" }, capability: "edit", expiresInSeconds: null }),
    });
    return { status: res.status, body: await res.json() };
  }, API);
  expect(link.status).toBe(201);
  expect(link.body.capability).toBe("edit");

  // the anonymous guest opens the link → the guest shell (reader chrome) with the space tree.
  const guest = await (await browser.newContext()).newPage();
  await guest.goto(`/share/${link.body.id}`);
  await expect(guest.getByTestId("guest-sidebar")).toBeVisible({ timeout: 15000 });
  // open the demo page from the guest tree (a space link lands on the space shell).
  await guest.getByTestId("guest-tree-page").filter({ hasText: "Demo Page" }).first().click();
  await guest.waitForSelector("[data-pane=preview] .cm-content", { timeout: 10000 });
  await sleep(800);

  // edit-capable: the guest reaches the editable surface and types; it syncs to the member live.
  await enterEdit(guest);
  expect(await guest.$eval("[data-pane=preview] .cm-content", (el) => el.getAttribute("contenteditable"))).toBe("true");
  await guest.click("[data-pane=preview] .cm-content");
  await guest.keyboard.type("from-space-guest");
  await sleep(800);
  expect(await paneText(member, "preview")).toContain("from-space-guest");

  // #274 §3: the guest CREATES a page from the sidebar affordance — created published atomically,
  // it opens in the editor and joins the tree.
  await guest.getByTestId("guest-new-page").click();
  await guest.getByTestId("guest-new-page-title").fill("Guest Wiki Page");
  await guest.keyboard.press("Enter");
  await guest.waitForSelector("[data-pane=preview] .cm-content", { timeout: 10000 });
  await expect(guest.getByTestId("guest-tree-page").filter({ hasText: "Guest Wiki Page" })).toBeVisible({ timeout: 10000 });

  // revoke → the guest loses the space (uniform denial on the next load).
  const revoke = await member.evaluate(async ({ api, id }) => {
    const res = await fetch(`${api}/share-links/${id}`, { method: "DELETE", headers: { Authorization: "Bearer dev-token" } });
    return res.status;
  }, { api: API, id: link.body.id });
  expect(revoke).toBe(204);
  await guest.reload();
  await sleep(1500);
  const revokedBody = await guest.locator("body").innerText();
  expect(revokedBody).not.toContain("from-space-guest"); // the page content is gone for the revoked link
});

test("#274: a VIEW space link shows no create affordance", async ({ browser }) => {
  const member = await (await browser.newContext()).newPage();
  await openDemo(member);
  const link = await member.evaluate(async (api) => {
    const res = await fetch(`${api}/share-links`, {
      method: "POST",
      headers: { Authorization: "Bearer dev-token", "Content-Type": "application/json" },
      body: JSON.stringify({ resource: { type: "space", id: "demo_space" }, capability: "view", expiresInSeconds: null }),
    });
    return (await res.json()) as { id: string };
  }, API);
  const guest = await (await browser.newContext()).newPage();
  await guest.goto(`/share/${link.id}`);
  await expect(guest.getByTestId("guest-sidebar")).toBeVisible({ timeout: 15000 });
  await expect(guest.getByTestId("guest-new-page")).toHaveCount(0); // read-only chrome stays write-free
});
