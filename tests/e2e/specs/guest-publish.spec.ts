import { test, expect, type Browser } from "@playwright/test";
import { openDemo, enterEdit, sleep } from "../helpers";

// 2f-3 guest path in a REAL browser. The load-bearing property: a VIEW share-link
// guest sees the PUBLISHED snapshot and NEVER the live draft (the guest never joins
// the collab room — the draft is not delivered to their browser). An EDIT guest can
// publish.
const API = "http://dev.localhost:4010";

async function newPage(page: import("@playwright/test").Page, title: string): Promise<string> {
  return page.evaluate(async ({ api, title }) => {
    const r = await fetch(`${api}/spaces/demo_space/pages`, {
      method: "POST",
      headers: { Authorization: "Bearer dev-token", "content-type": "application/json" },
      body: JSON.stringify({ title }),
    });
    return (await r.json()).id as string;
  }, { api: API, title });
}
async function shareUrl(page: import("@playwright/test").Page, pageId: string, capability: "view" | "edit"): Promise<string> {
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

test("guest VIEW link shows the published version, never the live draft", async ({ browser }: { browser: Browser }) => {
  const member = await (await browser.newContext()).newPage();
  await openDemo(member);
  const pageId = await newPage(member, "guest view page");
  await member.goto(`/p/${pageId}`);
  await member.waitForSelector("[data-pane=preview] .cm-content");
  await sleep(300);
  await enterEdit(member);
  await member.click("[data-pane=preview] .cm-content");
  await member.keyboard.type("PUBLISHEDFORGUEST");
  await sleep(2800);
  // publish, then add draft-only content that is NOT published
  await member.evaluate(async ({ api, pageId }) => {
    await fetch(`${api}/pages/${pageId}/publish`, { method: "POST", headers: { Authorization: "Bearer dev-token" } });
  }, { api: API, pageId });
  await member.keyboard.type(" DRAFTONLYFORGUEST");
  await sleep(2800);

  const url = await shareUrl(member, pageId, "view");
  const guest = await (await browser.newContext()).newPage();
  await guest.goto(url);
  await guest.waitForSelector("[data-pane=preview] .cm-content");
  await sleep(800);
  const text = await guest.locator("[data-pane=preview] .cm-content").innerText();
  expect(text).toContain("PUBLISHEDFORGUEST");        // the published snapshot
  expect(text).not.toContain("DRAFTONLYFORGUEST");    // the live draft never reaches a view guest
  // and it is read-only
  expect(await guest.$eval("[data-pane=preview] .cm-content", (el) => el.getAttribute("contenteditable"))).toBe("false");
});

test("guest EDIT link can publish", async ({ browser }: { browser: Browser }) => {
  const member = await (await browser.newContext()).newPage();
  await openDemo(member);
  const pageId = await newPage(member, "guest edit publish page");

  const url = await shareUrl(member, pageId, "edit");
  const guest = await (await browser.newContext()).newPage();
  await guest.goto(url);
  await guest.waitForSelector("[data-pane=preview] .cm-content");
  await sleep(800);
  await enterEdit(guest);
  await guest.click("[data-pane=preview] .cm-content");
  await guest.keyboard.type("PUBLISHEDBYGUEST");
  await sleep(2800);
  await guest.click("[data-testid=guest-publish]");
  await sleep(800);

  // the published content (read back via the member API) reflects the guest's publish
  const publishedMd = await member.evaluate(async ({ api, pageId }) => {
    const r = await fetch(`${api}/pages/${pageId}/published`, { headers: { Authorization: "Bearer dev-token" } });
    return ((await r.json()) as { publishedMd: string | null }).publishedMd;
  }, { api: API, pageId });
  expect(publishedMd ?? "").toContain("PUBLISHEDBYGUEST");
});
