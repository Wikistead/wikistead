import { test, expect, type Page } from "@playwright/test";
import { openScratch, createScratchPage, enterEdit, sleep, publishAndWait } from "../helpers";

// #224 / ADR-104 go-live: auto internal links. Body text matching a viewer-authorized page title is
// decorated as a link (display-only mark — the SOURCE stays plain text, Open formats); a click routes
// through the app (the destination re-confirms view); hovering shows a title+excerpt card fetched via
// a view-re-confirmed endpoint. The dictionary is viewer-scoped (the authz defence) and is refreshed
// by the security-timing invalidation channel (outbox → Valkey → collab stateless ping → refetch), so
// a rename/privatise/delete makes stale colored links disappear WITHOUT a reload (anti-test 4).
const API = "http://dev.localhost:4010";
const RUN = Date.now().toString(36);

async function renamePage(p: Page, pageId: string, title: string) {
  await p.evaluate(async ({ api, pageId, title }) => {
    await fetch(`${api}/pages/${pageId}`, {
      method: "PATCH",
      headers: { Authorization: "Bearer dev-token", "content-type": "application/json" },
      body: JSON.stringify({ title }),
    });
  }, { api: API, pageId, title });
}

test("#224 go-live: body text matching a page title renders the auto link; click navigates; source stays plain", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  const target = `Auto Link Target ${RUN}`;
  await page.goto("/p/demo");
  await page.waitForSelector("[data-pane=preview] .cm-content");
  const targetId = await createScratchPage(page, target);

  await openScratch(page, "title-links-host");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(`intro mentions ${target} in prose\n\nbot\n`);
  await sleep(600);
  await page.getByText("bot").click();

  const link = page.locator(`[data-pane=preview] .cm-lp-title-link[data-title-link="${targetId}"]`);
  await expect(link.first()).toBeVisible({ timeout: 10000 });

  // the SOURCE is untouched (display-only mark — no markdown link was written).
  await page.getByTestId("displaymode-source").click();
  await sleep(250);
  const src = await page.locator("[data-pane=preview] .cm-content").innerText();
  expect(src).toContain(`mentions ${target} in prose`);
  expect(src).not.toContain(`](/p/${targetId})`);
  await page.getByTestId("displaymode-live").click();
  await sleep(300);

  // click → SPA-navigates to the target page (whose route re-confirms view).
  await link.first().click();
  await expect(page).toHaveURL(new RegExp(`/p/${targetId}`), { timeout: 8000 });
});

// #350: an explicit markdown link whose LABEL equals a page title must NOT get the auto title-link decoration
// stacked on top (double link / conflicting target / #276 contradiction). (Plain-text auto-linking itself is
// covered by the #224 go-live test above — here we pin that a hand-written link is EXCLUDED.)
test("#350: a hand-written [title](/p/id) is NOT auto-title-linked", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  const target = `Manual Link Title ${RUN}`;
  await page.goto("/p/demo");
  await page.waitForSelector("[data-pane=preview] .cm-content");
  await createScratchPage(page, target); // the page whose title the hand link's label matches

  await openScratch(page, "manual-link-host");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  // the title INSIDE a hand link (pointing at a DIFFERENT id) — the auto-linker must not overlay it.
  await page.keyboard.insertText(`see [${target}](/p/some-other-id) here\n\nbot\n`);
  await sleep(600);
  await page.getByText("bot").click();
  await sleep(400);

  const handLine = page.locator("[data-pane=preview] .cm-line", { hasText: "see" }).first();
  await expect(handLine).toBeVisible();
  // the label renders as a real markdown link (cm-lp-link), NOT an auto title-link (no cm-lp-title-link over it).
  expect(await handLine.locator(`.cm-lp-title-link`).count(), "no auto title-link over a hand-written link").toBe(0);
});

test("#224 hover card: the excerpt card appears in the tooltip layer (view-re-confirmed fetch)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  const target = `Hover Card Target ${RUN}`;
  await page.goto("/p/demo");
  await page.waitForSelector("[data-pane=preview] .cm-content");
  const targetId = await createScratchPage(page, target);
  // publish the target so it has an excerpt body
  await page.goto(`/p/${targetId}?edit=1`);
  await page.waitForSelector("[data-pane=preview] .cm-content");
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.type("hover excerpt body 224");
  await publishAndWait(page, targetId, "hover excerpt body 224"); // #354: poll the published body, not a fixed sleep

  await openScratch(page, "title-links-hover");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(`see ${target} here\n\nbot\n`);
  await sleep(600);
  await page.getByText("bot").click();
  const link = page.locator(`[data-pane=preview] .cm-lp-title-link[data-title-link="${targetId}"]`).first();
  await expect(link).toBeVisible({ timeout: 10000 });
  await link.hover();
  const card = page.getByTestId("title-link-card");
  await expect(card).toBeVisible({ timeout: 5000 });
  await expect(card).toContainText(target);
  await expect(card).toContainText("hover excerpt body 224", { timeout: 5000 });
});

test("#224 anti-test 4 (security-timing): a RENAME makes the stale colored link disappear WITHOUT a reload", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  const target = `Stale Link Target ${RUN}`;
  await page.goto("/p/demo");
  await page.waitForSelector("[data-pane=preview] .cm-content");
  const targetId = await createScratchPage(page, target);

  await openScratch(page, "title-links-stale");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(`prose with ${target} inside\n\nbot\n`);
  await sleep(600);
  await page.getByText("bot").click();
  const link = page.locator(`[data-pane=preview] .cm-lp-title-link[data-title-link="${targetId}"]`);
  await expect(link.first()).toBeVisible({ timeout: 10000 });

  // rename the target via the API (enqueues the trusted outbox → Valkey wks:dict → collab stateless
  // ping → the OPEN editor refetches its dictionary and redecorates). NO reload happens here.
  await renamePage(page, targetId, `Renamed Away ${RUN}`);

  // the colored link must disappear IN-WINDOW by EVENT (the TTL refetch is 120s — far beyond this
  // timeout — so a pass proves the event path, the looseness check the ADR demands).
  await expect(link).toHaveCount(0, { timeout: 20000 });
});

test("#224 guest surface: NO auto links render for a guest (uninjected — 2-layer anti-test 3b)", async ({ browser }) => {
  const member = await (await browser.newContext()).newPage();
  const target = `Guest NoLink Target ${RUN}`;
  await member.goto("/p/demo");
  await member.waitForSelector("[data-pane=preview] .cm-content");
  await createScratchPage(member, target);

  // a page whose body MENTIONS the target title, shared to a guest
  const hostId = await createScratchPage(member, `guest-titlelink-host-${RUN}`);
  await member.goto(`/p/${hostId}?edit=1`);
  await member.waitForSelector("[data-pane=preview] .cm-content");
  await member.click("[data-pane=preview] .cm-content");
  await member.keyboard.type(`guest body mentions ${target} here`);
  await publishAndWait(member, hostId, "guest body mentions"); // #354: poll the published body, not a fixed sleep
  const linkId = await member.evaluate(async ({ api, id }) => {
    const r = await fetch(`${api}/share-links`, {
      method: "POST",
      headers: { Authorization: "Bearer dev-token", "content-type": "application/json" },
      body: JSON.stringify({ resource: { type: "page", id }, capability: "view", expiresInSeconds: null }),
    });
    return (await r.json()).id as string;
  }, { api: API, id: hostId });

  const guest = await (await browser.newContext()).newPage();
  await guest.goto(`/share/${linkId}`);
  await guest.waitForSelector("[data-pane=preview] .cm-content");
  await expect(guest.locator("[data-pane=preview] .cm-content")).toContainText(target);
  // assert the DECORATION is absent (not merely hidden) — the 2-layer requirement's e2e layer.
  await expect(guest.locator(".cm-lp-title-link")).toHaveCount(0);
});
