import { test, expect, type Browser } from "@playwright/test";
import { openDemo, enterEdit, sleep, API } from "../helpers";

// 2f-3 guest path in a REAL browser. The load-bearing property: a VIEW share-link
// guest sees the PUBLISHED snapshot and NEVER the live draft (the guest never joins
// the collab room — the draft is not delivered to their browser). An EDIT guest can
// publish.
const PNG_1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

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

test("guest VIEW link renders a published image (guest image resolution)", async ({ browser }: { browser: Browser }) => {
  const member = await (await browser.newContext()).newPage();
  await openDemo(member);
  const pageId = await newPage(member, "guest image page");
  await member.goto(`/p/${pageId}`);
  await member.waitForSelector("[data-pane=preview] .cm-content");
  await sleep(300);

  // upload an image via the attachments panel (proven path) — open it from the ⋯ menu
  await member.click("[data-testid=page-overflow-trigger]");
  await member.click("[data-testid=attachments-toggle]");
  await member.waitForSelector("[data-testid=attachments-panel]");
  await sleep(200);
  await member.setInputFiles("[data-testid=attachments-panel] input[type=file]", { name: "g.png", mimeType: "image/png", buffer: Buffer.from(PNG_1x1, "base64") });
  await member.waitForFunction(() => [...document.querySelectorAll("[data-testid=attach-item]")].some((e) => (e as HTMLElement).innerText.includes("g.png")), undefined, { timeout: 8000 });
  const attId = await member.evaluate(async ({ api, pageId }) => {
    const list = await (await fetch(`${api}/spaces/demo_space/pages/${pageId}/attachments`, { headers: { Authorization: "Bearer dev-token" } })).json();
    return (list.find((a: { filename: string }) => a.filename === "g.png") as { id: string }).id;
  }, { api: API, pageId });

  // reference it in the draft, then PUBLISH
  await enterEdit(member);
  await member.click("[data-pane=preview] .cm-content");
  await member.keyboard.type(`![pic](wks-attachment:${attId})`);
  await sleep(2800);
  await member.evaluate(async ({ api, pageId }) => {
    await fetch(`${api}/pages/${pageId}/publish`, { method: "POST", headers: { Authorization: "Bearer dev-token" } });
  }, { api: API, pageId });

  // guest opens the VIEW link → the published image renders AND actually loads
  const url = await shareUrl(member, pageId, "view");
  const guest = await (await browser.newContext()).newPage();
  await guest.goto(url);
  await guest.waitForSelector("[data-pane=preview] .cm-content");
  const img = guest.locator("[data-pane=preview] img.cm-lp-image");
  await expect(img).toBeVisible({ timeout: 8000 });
  await expect.poll(async () => img.evaluate((el: HTMLImageElement) => el.naturalWidth), { timeout: 8000 }).toBeGreaterThan(0);
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
  await guest.click("[data-testid=publish-page]"); // Publish in the edit-mode toolbar
  await sleep(800);

  // the published content (read back via the member API) reflects the guest's publish
  const publishedMd = await member.evaluate(async ({ api, pageId }) => {
    const r = await fetch(`${api}/pages/${pageId}/published`, { headers: { Authorization: "Bearer dev-token" } });
    return ((await r.json()) as { publishedMd: string | null }).publishedMd;
  }, { api: API, pageId });
  expect(publishedMd ?? "").toContain("PUBLISHEDBYGUEST");
});

// #917: PageStatus's "unpublished" badge and Editor's dirtySignal, member-surface parity for guests.
test("#917: an EDIT-link guest sees the unpublished badge while a draft diverges, and it clears on publish", async ({ browser }: { browser: Browser }) => {
  const member = await (await browser.newContext()).newPage();
  await openDemo(member);
  const pageId = await newPage(member, "guest unpublished badge page");
  // published once already, so the badge's FIRST appearance is unambiguously due to the guest's own
  // edit diverging from it — not "a brand new page has nothing published yet".
  await member.goto(`/p/${pageId}`);
  await member.waitForSelector("[data-pane=preview] .cm-content");
  await sleep(300);
  await enterEdit(member);
  await member.click("[data-pane=preview] .cm-content");
  await member.keyboard.type("ALREADYPUBLISHED917");
  await sleep(2800);
  await member.evaluate(async ({ api, pageId }) => {
    await fetch(`${api}/pages/${pageId}/publish`, { method: "POST", headers: { Authorization: "Bearer dev-token" } });
  }, { api: API, pageId });

  const url = await shareUrl(member, pageId, "edit");
  const guest = await (await browser.newContext()).newPage();
  await guest.goto(url);
  await guest.waitForSelector("[data-pane=preview] .cm-content");
  await sleep(800);
  // nothing diverges yet — the badge is absent, not merely invisible-but-present
  await expect(guest.getByTestId("unpublished-badge")).toHaveCount(0);

  await enterEdit(guest);
  await guest.click("[data-pane=preview] .cm-content");
  await guest.keyboard.type(" GUESTDIVERGES917");
  // #917's own poll (1500ms, member-surface cadence) — no fixed-interval assumption beyond that; this
  // waits for the badge itself rather than a guessed settle time.
  await expect(guest.getByTestId("unpublished-badge")).toBeVisible({ timeout: 8_000 });

  await guest.click("[data-testid=publish-page]");
  await expect(guest.getByTestId("unpublished-badge")).toHaveCount(0, { timeout: 8_000 });
});

test("#917: a VIEW-link guest never sees the unpublished badge (member-only surface)", async ({ browser }: { browser: Browser }) => {
  const member = await (await browser.newContext()).newPage();
  await openDemo(member);
  const pageId = await newPage(member, "guest view no badge page");
  await member.goto(`/p/${pageId}`);
  await member.waitForSelector("[data-pane=preview] .cm-content");
  await sleep(300);
  await enterEdit(member);
  await member.click("[data-pane=preview] .cm-content");
  await member.keyboard.type("VIEWERSEESNOTHING917");
  await sleep(2800);
  // NOT published — this member-side draft is exactly the kind of divergence the badge exists for,
  // and a view guest must not be told about it in any form (they cannot act on it either way).
  const url = await shareUrl(member, pageId, "view");
  const guest = await (await browser.newContext()).newPage();
  await guest.goto(url);
  await guest.waitForSelector("[data-pane=preview] .cm-content");
  await sleep(800);
  await expect(guest.getByTestId("unpublished-badge")).toHaveCount(0);
  await expect(guest.getByTestId("draft-badge")).toHaveCount(0);
});
