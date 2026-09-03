import { test, expect } from "@playwright/test";
import { openDemo, openScratch, enterEdit, publishAndWait, sleep, API } from "../helpers";
// #449 / ADR-173: a space-link guest gets the SAME search box the member uses — Ctrl-K + the header
// field — scoped by the server to the link's space and gated on the share_link principal. The leak
// class is pinned server-side (guest-search-449.test.ts); this pins the UI reuse: the search chrome
// mounts on the guest shell, a query returns the space's pages, and a hit opens INSIDE /share/… via
// the tree's own handler (never a dead /p/<id> member route). No member chrome leaks.
test("#449: a space-link guest can search their space and a hit opens in the guest shell", async ({ browser }) => {
  const member = await (await browser.newContext()).newPage();
  const term = `GuestFind${Date.now()}`;

  // A REAL published page in demo_space (the e2e seed does not populate the search index, so we make
  // one whose title we can search for). PUBLISHING is what a guest needs — it gives the page its
  // page#space edge (the stage-2 view_base_from_space) and puts its body in the index.
  const id = await openScratch(member, term);
  await enterEdit(member);
  await member.click("[data-pane=preview] .cm-content");
  await member.keyboard.insertText(`# ${term}\n\n${term} body text`);
  await sleep(300);
  await publishAndWait(member, id, `${term} body`);
  // indexing is async (outbox → Meili); poll the API directly (not the UI, which would cache)
  // #989: plain NODE-side fetch, not page.evaluate — see helpers.ts's createScratchPage for why.
  await expect.poll(
    async () => {
      const r = await fetch(`${API}/search?q=${encodeURIComponent(term)}`, { headers: { Authorization: "Bearer dev-token" } });
      return ((await r.json()) as unknown[]).length;
    },
    { timeout: 20_000, intervals: [500, 1000, 1000] },
  ).toBeGreaterThan(0);

  const linkRes = await fetch(`${API}/share-links`, {
    method: "POST",
    headers: { Authorization: "Bearer dev-token", "Content-Type": "application/json" },
    body: JSON.stringify({ resource: { type: "space", id: "demo_space" }, capability: "view", expiresInSeconds: null }),
  });
  const link = { status: linkRes.status, body: (await linkRes.json()) as { id: string } };
  expect(link.status).toBe(201);

  const guest = await (await browser.newContext()).newPage();
  // #449 addendum pin: the guest preview must NEVER touch the member meta route (`GET /api/pages/:id`
  // with no sub-path) — its only page read is the guest-gated `/pages/:id/published`. Record every
  // matching request for the whole session and assert none occurred after the preview rendered.
  const memberMetaRequests: string[] = [];
  guest.on("request", (r) => {
    const path = new URL(r.url()).pathname;
    if (/^\/api\/pages\/[^/]+$/.test(path) && r.method() === "GET") memberMetaRequests.push(path);
  });
  await guest.goto(`/share/${link.body.id}`);
  await expect(guest.getByTestId("guest-sidebar")).toBeVisible({ timeout: 15000 });

  // the search trigger is present on the guest shell (it was absent before #449) …
  const trigger = guest.getByTestId("search-trigger");
  await expect(trigger, "the guest shell mounts the search box").toBeVisible();
  await trigger.click();
  await expect(guest.getByTestId("search-input")).toBeVisible();

  // … a query returns the space's published page (the demo page is public in the demo space) …
  await guest.getByTestId("search-input").fill(term);
  const item = guest.getByTestId("search-item").filter({ hasText: term }).first();
  await expect(item, "the guest sees the space's page in results").toBeVisible({ timeout: 10000 });

  // … the preview pane renders for the highlighted hit BEFORE selection (#449 addendum: the
  // ruling withdrew the v1 guest-OFF state; the pane fetches the guest-gated /published route) …
  await expect(guest.getByTestId("search-preview"), "the guest gets the preview pane").toBeVisible();
  await expect(guest.getByTestId("search-preview-rendered"), "the published body renders in the pane").toBeVisible({ timeout: 10000 });
  // #1070: assert the TEXT, not a one-shot read taken once the element is up. `toBeVisible` answers
  // "the pane mounted"; the body arrives over a later fetch, so a plain `evaluate` after it reads
  // whatever happens to be there — on a slow runner, "".
  await expect(
    guest.getByTestId("search-preview-rendered"),
    "the preview shows the page's published body",
  ).toContainText(term.slice(0, 9), { timeout: 15000 });
  expect(memberMetaRequests, "the guest surface never called the member page-meta route").toEqual([]);

  // … and choosing a hit opens it INSIDE the guest shell (the tree's open handler), not /p/<id>.
  await item.click();
  // #1070: the guest shell already has a `.cm-content` mounted from the shared page, so waiting for
  // the SELECTOR returns at once and the fixed sleep that followed was the only thing standing in
  // for the document load. Wait for the hit's own text instead.
  await expect(
    guest.locator("[data-pane=preview] .cm-content"),
    "the hit's body loads into the guest shell's editor",
  ).toContainText(term.slice(0, 9), { timeout: 15000 });
  expect(guest.url(), "stays inside /share/… — never a dead member /p/ route").toContain("/share/");

  // no member chrome bled in with the search box.
  await expect(guest.getByTestId("user-menu"), "no member user menu on the guest shell").toHaveCount(0);
});

// #449: Ctrl-K opens the same modal on the guest shell (keyboard parity with the member surface).
test("#449: Ctrl-K opens guest search", async ({ browser }) => {
  test.skip(true, "#1088: isolated — under the gate's full run openDemo's wait for the preview surface times out at 60s (same family as #973); the spec passes solo, re-measured twice");
  const member = await (await browser.newContext()).newPage();
  await openDemo(member);
  // #989: plain NODE-side fetch, not page.evaluate — see helpers.ts's createScratchPage for why.
  const linkRes = await fetch(`${API}/share-links`, {
    method: "POST",
    headers: { Authorization: "Bearer dev-token", "Content-Type": "application/json" },
    body: JSON.stringify({ resource: { type: "space", id: "demo_space" }, capability: "view", expiresInSeconds: null }),
  });
  const link = ((await linkRes.json()) as { id: string }).id;

  const guest = await (await browser.newContext()).newPage();
  await guest.goto(`/share/${link}`);
  await expect(guest.getByTestId("guest-sidebar")).toBeVisible({ timeout: 15000 });
  await guest.keyboard.press("Control+k");
  await expect(guest.getByTestId("search-input"), "Ctrl-K opens the guest search modal").toBeVisible({ timeout: 5000 });
});
