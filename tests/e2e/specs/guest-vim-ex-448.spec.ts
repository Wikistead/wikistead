import { test, expect, type Page } from "@playwright/test";
import { openDemo, sleep, API } from "../helpers";

// #448: vim :w/:wq/:q on the GUEST edit surface. The server publish route has been guest:'edit'
// since #328/ADR-140 (FGA edit gate + rate cap + abuse filter + anonId attribution) — only the
// client wiring was missing: the guest Editor got no onExitEdit/onPublish, so the vim ex commands
// resolved to undefined and silently no-opped. This drives a real EDIT-link guest through
// :wq (publish + exit) and :q (exit only), and pins that a VIEW-link guest still cannot publish.
async function newPage(page: Page, title: string): Promise<string> {
  return page.evaluate(async ({ api, title }) => {
    const r = await fetch(`${api}/spaces/demo_space/pages`, {
      method: "POST",
      headers: { Authorization: "Bearer dev-token", "content-type": "application/json" },
      body: JSON.stringify({ title }),
    });
    return (await r.json()).id as string;
  }, { api: API, title });
}
async function shareUrl(page: Page, pageId: string, capability: "view" | "edit"): Promise<string> {
  const id = await page.evaluate(async ({ api, pageId, capability }) => {
    const r = await fetch(`${api}/share-links`, {
      method: "POST",
      headers: { Authorization: "Bearer dev-token", "content-type": "application/json" },
      body: JSON.stringify({ resource: { type: "page", id: pageId }, capability, expiresInSeconds: null }),
    });
    return (await r.json()).id as string;
  }, { api: API, pageId, capability });
  return `/share/${id}`;
}

test("#448: an EDIT-link guest publishes with :wq and exits with :q", async ({ browser }) => {
  const member = await (await browser.newContext()).newPage();
  await openDemo(member);
  const pageId = await newPage(member, "guest vim ex page");
  await member.evaluate(async ({ api, pageId }) => {
    await fetch(`${api}/pages/${pageId}/publish`, { method: "POST", headers: { Authorization: "Bearer dev-token" } });
  }, { api: API, pageId });

  const guest = await (await browser.newContext()).newPage();
  await guest.goto(await shareUrl(member, pageId, "edit"));
  await guest.waitForSelector("[data-pane=preview] .cm-content");
  await sleep(400);

  // enter edit + vim, type content
  await guest.getByTestId("edit-toggle").click();
  await sleep(400);
  await guest.getByTestId("vim-toggle").click();
  await sleep(300);
  await guest.click("[data-pane=preview] .cm-content");
  await guest.keyboard.press("i");
  await guest.keyboard.type("GUESTVIMPUBLISHED");
  await guest.keyboard.press("Escape");
  await sleep(2600); // let the collab draft persist past the debounce

  // :wq → publish + exit edit (the edit toggle reappears = view mode)
  await guest.keyboard.type(":wq");
  await guest.keyboard.press("Enter");
  await expect(guest.getByTestId("edit-toggle")).toBeVisible({ timeout: 10_000 });
  await sleep(600);

  // the publish LANDED: a fresh VIEW-link guest sees the text in the published snapshot
  const viewer = await (await browser.newContext()).newPage();
  await viewer.goto(await shareUrl(member, pageId, "view"));
  await viewer.waitForSelector("[data-pane=preview] .cm-content");
  await expect(viewer.locator("[data-pane=preview] .cm-content")).toContainText("GUESTVIMPUBLISHED", { timeout: 10_000 });

  // :q exits WITHOUT publishing
  await guest.getByTestId("edit-toggle").click();
  await sleep(400);
  await guest.click("[data-pane=preview] .cm-content");
  await guest.keyboard.press("i");
  await guest.keyboard.type(" DRAFTONLY448");
  await guest.keyboard.press("Escape");
  await sleep(2600);
  await guest.keyboard.type(":q");
  await guest.keyboard.press("Enter");
  await expect(guest.getByTestId("edit-toggle")).toBeVisible({ timeout: 10_000 });
  await viewer.reload();
  await viewer.waitForSelector("[data-pane=preview] .cm-content");
  await sleep(600);
  await expect(viewer.locator("[data-pane=preview] .cm-content")).not.toContainText("DRAFTONLY448");
});

// #911: on the guest edit surface too, :w must publish and STAY in the editor (only :wq exits).
test("#911: a GUEST edit-link guest's :w publishes and stays in the editor", async ({ browser }) => {
  const member = await (await browser.newContext()).newPage();
  await openDemo(member);
  const pageId = await newPage(member, "guest vim w page");

  const guest = await (await browser.newContext()).newPage();
  await guest.goto(await shareUrl(member, pageId, "edit"));
  await guest.waitForSelector("[data-pane=preview] .cm-content");
  await sleep(400);

  await guest.getByTestId("edit-toggle").click();
  await sleep(400);
  await guest.getByTestId("vim-toggle").click();
  await sleep(300);
  await guest.click("[data-pane=preview] .cm-content");
  await guest.keyboard.press("i");
  await guest.keyboard.type("GUEST W STAYS");
  await guest.keyboard.press("Escape");
  await sleep(300);

  await guest.keyboard.type(":w");
  await guest.keyboard.press("Enter");

  await expect(guest.getByText(/^Published$|^公開しました$/)).toBeVisible({ timeout: 10_000 });
  // :w must NOT exit — the edit toggle stays absent, the surface stays editable.
  await sleep(500);
  expect(await guest.getByTestId("edit-toggle").count()).toBe(0);
  await expect(guest.locator("[data-pane=preview] .cm-content")).toHaveAttribute("contenteditable", "true");

  // the publish LANDED despite staying: a fresh VIEW-link guest sees the text.
  const viewer = await (await browser.newContext()).newPage();
  await viewer.goto(await shareUrl(member, pageId, "view"));
  await viewer.waitForSelector("[data-pane=preview] .cm-content");
  await expect(viewer.locator("[data-pane=preview] .cm-content")).toContainText("GUEST W STAYS", { timeout: 10_000 });
});

test("#448: a VIEW-link guest cannot publish (server bastion — 40x, not 200)", async ({ browser }) => {
  const member = await (await browser.newContext()).newPage();
  await openDemo(member);
  const pageId = await newPage(member, "guest view no publish");
  await member.evaluate(async ({ api, pageId }) => {
    await fetch(`${api}/pages/${pageId}/publish`, { method: "POST", headers: { Authorization: "Bearer dev-token" } });
  }, { api: API, pageId });
  const url = await shareUrl(member, pageId, "view");
  const linkId = url.split("/").pop()!;
  // mint the guest token the same way the landing page does, then fire the publish POST with it
  const status = await member.evaluate(async ({ api, pageId, linkId }) => {
    const mint = await fetch(`${api}/public/share-links/${linkId}/token`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const { token } = await mint.json();
    const r = await fetch(`${api}/pages/${pageId}/publish`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
    return r.status;
  }, { api: API, pageId, linkId });
  expect(status).toBeGreaterThanOrEqual(400);
});
