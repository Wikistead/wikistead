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

  // #274 §3: the guest CREATES a page with the MEMBER new-page control — same testid/shape,
  // click → an "Untitled" page immediately (created published atomically) → the editor opens in edit
  // mode; naming happens in the title band, member-parity.
  await guest.getByTestId("guest-sidebar").getByTestId("new-page").click();
  await guest.waitForSelector("[data-pane=preview] .cm-content", { timeout: 10000 });
  await expect
    .poll(async () => guest.$eval("[data-pane=preview] .cm-content", (el) => el.getAttribute("contenteditable")), { timeout: 10000 })
    .toBe("true"); // opened straight in edit mode (member parity)
  const band = guest.getByTestId("guest-title-band");
  await band.locator("button[data-testid=page-title]").click();
  await band.getByTestId("page-title-input").fill("Guest Wiki Page");
  await guest.keyboard.press("Enter");
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

// #274 (review return): the space-share COPY still said "view-only" (the #104 wording),
// which sent the user to the page link instead — the space edit link looked like it didn't exist. Pin
// the dialog warning to the new copy (capability is selectable; an editable link = anonymous wiki).
test("#274: the space share dialog copy says the link capability is selectable (not view-only)", async ({ browser }) => {
  const member = await (await browser.newContext()).newPage();
  await openDemo(member);
  await member.getByTestId("space-settings-open").click();
  await member.getByTestId("space-share").click();
  const warning = member.getByTestId("share-space-warning");
  await expect(warning).toBeVisible({ timeout: 8000 });
  const text = await warning.innerText();
  expect(text, "the stale view-only wording is gone").not.toMatch(/view-only|閲覧専用/);
  expect(text, "the editable capability is mentioned").toMatch(/editable|編集可/i);
});

// #274 (optional item, bundled): a shell WITHOUT a sidebar must not render the decorative
// PanelLeft icon — it read as a broken "expand sidebar" control on the guest page / settings shells.
test("#274: the sidebar-less shell renders no dead sidebar-toggle icon", async ({ browser }) => {
  const member = await (await browser.newContext()).newPage();
  await member.goto("/settings/account");
  await member.waitForSelector("header", { timeout: 10000 });
  await expect(member.getByTestId("sidebar-toggle")).toHaveCount(0);
  await expect(member.locator("header svg.lucide-panel-left"), "no decorative panel icon").toHaveCount(0);
  // and the member page shell (WITH sidebar) keeps the working toggle — the control itself is not gone.
  await openDemo(member);
  await expect(member.getByTestId("sidebar-toggle")).toBeVisible({ timeout: 8000 });
});
