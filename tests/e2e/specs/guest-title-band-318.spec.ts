import { test, expect, type Page } from "@playwright/test";
import { openDemo, sleep, API } from "../helpers";

// #318: the guest share surface renders the SAME frosted title band as the member page / public reader
// (it had none — the body started with no page title anywhere). The title arrives on the guest's only
// page read (GET /pages/:id/published, view-gated); the band is READ-ONLY chrome: no rename affordance
// leaks to a guest even with edit capability (rename stays member-only server-side), and the band
// height is published as --wks-band-h so the editor's first line and TOC/anchor jumps clear it.
// #989: plain NODE-side fetch, not page.evaluate — a browser-context fetch is subject to the app's real
// (now same-origin-only) CORS policy, and `API` is a different port than the page (see helpers.ts's
// createScratchPage for the full reasoning). Node's own fetch is not subject to it.
async function newPublishedPage(page: Page, title: string): Promise<string> {
  const r = await fetch(`${API}/spaces/demo_space/pages`, {
    method: "POST",
    headers: { Authorization: "Bearer dev-token", "content-type": "application/json" },
    body: JSON.stringify({ title }),
  });
  const id = ((await r.json()) as { id: string }).id;
  await page.goto(`/p/${id}?edit=1`);
  await page.waitForSelector("[data-pane=preview] .cm-content");
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.type("guest band body text");
  await sleep(2800); // collab persist debounce
  await fetch(`${API}/pages/${id}/publish`, { method: "POST", headers: { Authorization: "Bearer dev-token" } });
  return id;
}

async function shareUrl(pageId: string, capability: "view" | "edit"): Promise<string> {
  const r = await fetch(`${API}/share-links`, {
    method: "POST",
    headers: { Authorization: "Bearer dev-token", "content-type": "application/json" },
    body: JSON.stringify({ resource: { type: "page", id: pageId }, capability, expiresInSeconds: null }),
  });
  const id = ((await r.json()) as { id: string }).id;
  return `/share/${id}`;
}

const TITLE = "Guest Band Title 318";

test("#318 view guest: the title band shows the page title; no rename affordance; band height published", async ({ browser }) => {
  test.skip(true, "#1020: isolated — intermittent Target.createTarget failure late in the #891 gate's 20-spec run; green standalone (2026-09-01)");
  const member = await (await browser.newContext()).newPage();
  await openDemo(member);
  const pageId = await newPublishedPage(member, TITLE);
  const url = await shareUrl(pageId, "view");

  const guest = await (await browser.newContext()).newPage();
  await guest.goto(url);
  await guest.waitForSelector("[data-pane=preview] .cm-content");

  // the band renders the page title as a READ-ONLY h1 (PageTitle without onRename).
  const band = guest.getByTestId("guest-title-band");
  await expect(band).toBeVisible();
  await expect(band.locator("h1[data-testid=page-title]")).toContainText(TITLE);
  // no member chrome: no rename button/input variant of the title, anywhere on the surface.
  await expect(guest.locator("button[data-testid=page-title]")).toHaveCount(0);
  await expect(guest.getByTestId("page-title-input")).toHaveCount(0);

  // the band's ACTUAL height is published as --wks-band-h, and the REAL contract is the editor content
  // padding its top by it (tokens.css) so the first line + TOC/anchor jumps clear the frosted overlay
  // (#212/#304). Assert the computed padding — the end of that chain.
  await expect.poll(async () => guest.evaluate(() =>
    parseFloat(getComputedStyle(document.querySelector("[data-pane=preview] .cm-content")!).paddingTop) || 0,
  )).toBeGreaterThan(30);
});

// #274 SUPERSEDES the original #318 rule for EDIT capability: guests can now create pages
// ("Untitled"), so naming happens in the editor title band exactly like members — the title renders as
// the click-to-rename button and a rename round-trips. VIEW capability keeps the read-only h1 (above).
test("#318/#274 edit guest: the band title is click-to-rename (member parity) and persists", async ({ browser }) => {
  const member = await (await browser.newContext()).newPage();
  await openDemo(member);
  const pageId = await newPublishedPage(member, TITLE + " E");
  const url = await shareUrl(pageId, "edit");

  const guest = await (await browser.newContext()).newPage();
  await guest.goto(url);
  await guest.waitForSelector("[data-pane=preview] .cm-content");

  const band = guest.getByTestId("guest-title-band");
  await expect(band).toBeVisible();
  await expect(band.locator("button[data-testid=page-title]")).toContainText(TITLE + " E");
  await band.locator("button[data-testid=page-title]").click();
  await band.getByTestId("page-title-input").fill(TITLE + " E renamed");
  await guest.keyboard.press("Enter");
  await expect(band.locator("button[data-testid=page-title]")).toContainText(TITLE + " E renamed", { timeout: 5000 });
  // the rename PERSISTED server-side (not just local state)
  await guest.reload();
  await guest.waitForSelector("[data-pane=preview] .cm-content");
  await expect(guest.getByTestId("guest-title-band").locator("[data-testid=page-title]")).toContainText(TITLE + " E renamed");
});
