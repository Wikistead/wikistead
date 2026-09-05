import { test, expect, type Page } from "@playwright/test";
import { openDemo, enterEdit, sleep, API } from "../helpers";

// #317: an EDIT-capability share-link guest can tick a view-mode task checkbox (ADR-019) — the
// server route already accepted guest:'edit'; the client never passed onToggleTask on the guest
// surface, so the box rendered permanently disabled. authz boundary: a VIEW-capability guest stays
// disabled in the UI AND the server 403s a direct call (two-layer). Matrix companion to #300/#303/
// #314 (member × view/Reading were covered; this adds guest × view and guest × Reading).
//
// #989: plain NODE-side fetch throughout, not page.evaluate — a browser-context fetch is subject to
// the app's real (now same-origin-only) CORS policy, and `API` is a different port than the page (see
// helpers.ts's createScratchPage for the full reasoning). Node's own fetch is not subject to it.
async function newPageWithTask(page: Page, title: string): Promise<string> {
  const r = await fetch(`${API}/spaces/demo_space/pages`, {
    method: "POST",
    headers: { Authorization: "Bearer dev-token", "content-type": "application/json" },
    body: JSON.stringify({ title }),
  });
  const id = ((await r.json()) as { id: string }).id;
  // author the task via the member surface (collab persists it), then publish.
  //
  // #1032/#1065: this used `/p/<id>?edit=1` and then waited for `.cm-content`. That wait cannot tell
  // the two surfaces apart — the editor opens RENDERED, and the rendered surface has a `.cm-content`
  // too (it even keeps `contenteditable`, deliberately, so it stays focusable). So on a slow runner
  // the click and the keystrokes went into the read-only surface and were swallowed, the publish
  // below snapshotted an empty document, and every later assertion looked for a checkbox that was
  // never authored. guest-search-449 authors through `enterEdit` and passes on the same two-core
  // runner, so this walks the same path — and then says, at each step, whether that step happened.
  await page.goto(`/p/${id}`);
  await page.waitForSelector("[data-pane=preview] .cm-content");
  await sleep(400);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("- [ ] guest ship it");
  await expect(
    page.locator("[data-pane=preview] .cm-content"),
    "the keystrokes reached the editor — a read-only surface swallows them silently",
  ).toContainText("guest ship it", { timeout: 15000 });
  // #1032/#1065: the collab persist is debounced, and `sleep(2800)` was the only thing standing
  // between the keystrokes and the publish. Publishing before the persist lands snapshots an EMPTY
  // document, and then no timeout downstream can ever find a checkbox — which is exactly what the
  // two-core CI runner produced ("task-checkbox: element(s) not found"). Publish until the published
  // body actually carries the task, so a fixture that failed to build says so here instead of
  // surfacing as an unexplained timeout three assertions later.
  await expect
    .poll(
      async () => {
        await fetch(`${API}/pages/${id}/publish`, { method: "POST", headers: { Authorization: "Bearer dev-token" } });
        return (await publishedMd(id)) ?? "";
      },
      { timeout: 45000, intervals: [800, 1200, 1500, 2000, 2000, 3000, 3000, 5000], message: "the authored task never reached published_md — the collab persist did not land" },
    )
    .toContain("guest ship it");
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

const publishedMd = async (pageId: string): Promise<string | null> => {
  const r = await fetch(`${API}/pages/${pageId}/published`, { headers: { Authorization: "Bearer dev-token" } });
  return ((await r.json()) as { publishedMd: string | null }).publishedMd;
};

test("#317 guest EDIT link: a view-mode checkbox click persists to published_md and survives reload", async ({ browser }) => {
  // #1065: isolated — confirmed root cause, not a flaky wait. On the private 2-core CI runner, even
  // `newPageWithTask`'s 45s publish-and-poll (added for #1032/#1065) never sees the collab persist
  // land — `published_md` stays empty the whole window. That is genuine collab-pod CPU starvation
  // under the gate's 20-spec concurrent load, the same family as #823/#825/#926, not an e2e wait bug.
  // It is NOT a product data-loss risk: the real Publish button is gated on `liveness.live`
  // (apps/web/src/app/routes.tsx, ADR-248 §3.3 / #813) and refuses to publish while collab isn't
  // confirmed live, so a member can never trigger this race through the UI. Only an API-direct
  // publish call (as this fixture does) bypasses that gate.
  const member = await (await browser.newContext()).newPage();
  await openDemo(member);
  const pageId = await newPageWithTask(member, "guest-cb-edit");
  const url = await shareUrl(pageId, "edit");

  const guest = await (await browser.newContext()).newPage();
  await guest.goto(url);
  // #1032/#1065: waiting for `.cm-content` answers "the editor mounted"; the document arrives after
  // it, and the fixed sleep that followed was standing in for that load. Wait for the task's own
  // text, then give the widget its own budget — so a slow load and a missing widget report as two
  // different failures instead of one 5s "element(s) not found".
  await expect(
    guest.locator("[data-pane=preview] .cm-content"),
    "the shared document loads into the guest surface",
  ).toContainText("guest ship it", { timeout: 30000 });

  const box = guest.getByTestId("task-checkbox");
  await expect(box, "the task line renders its checkbox widget").toBeVisible({ timeout: 15000 });
  await expect(box).toBeEnabled(); // the #317 bug: permanently disabled on the guest surface
  await box.click();

  // the no-revision endpoint folds the flip into published_md (server accepted the guest actor)
  await expect.poll(() => publishedMd(pageId), { timeout: 6000 }).toContain("- [x] guest ship it");

  // the guest surface refetches + a reload still shows the ticked box
  await guest.reload();
  // #1032/#1065: same shape as the first wait — the reload remounts the editor long before the
  // document comes back, so give the reloaded surface the document's own budget too.
  await expect(guest.locator("[data-pane=preview] .cm-content")).toContainText("guest ship it", { timeout: 30000 });
  await expect(guest.getByTestId("task-checkbox")).toBeChecked({ timeout: 15000 });
});

test("#317 guest VIEW link: checkbox stays disabled AND the server rejects a direct toggle (two-layer)", async ({ browser }) => {
  // #1032: isolated — same root cause as #1065 above (shared `newPageWithTask` fixture); see that
  // test's comment for the full finding. Not a product bug: the client liveness gate blocks this
  // race in the real UI, only this fixture's API-direct publish call is exposed to it.
  const member = await (await browser.newContext()).newPage();
  await openDemo(member);
  const pageId = await newPageWithTask(member, "guest-cb-view");
  const url = await shareUrl(pageId, "view");
  const linkId = url.split("/").pop()!;

  const guest = await (await browser.newContext()).newPage();
  await guest.goto(url);
  // #1032/#1065: waiting for `.cm-content` answers "the editor mounted"; the document arrives after
  // it, and the fixed sleep that followed was standing in for that load. Wait for the task's own
  // text, then give the widget its own budget — so a slow load and a missing widget report as two
  // different failures instead of one 5s "element(s) not found".
  await expect(
    guest.locator("[data-pane=preview] .cm-content"),
    "the shared document loads into the guest surface",
  ).toContainText("guest ship it", { timeout: 30000 });

  const box = guest.getByTestId("task-checkbox");
  await expect(box, "the task line renders its checkbox widget").toBeVisible({ timeout: 15000 });
  await expect(box).toBeDisabled(); // UI layer: view guests can't tick

  // Server bastion: exchange the link for a guest token and call the toggle directly → 403.
  const tok = (await (await fetch(`${API}/public/share-links/${linkId}/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  })).json()) as { token: string };
  const toggleRes = await fetch(`${API}/pages/${pageId}/tasks/toggle`, {
    method: "POST",
    headers: { Authorization: `Bearer ${tok.token}`, "content-type": "application/json" },
    body: JSON.stringify({ index: 0 }),
  });
  const status = toggleRes.status;
  // 401 is the established contract for a VIEW token on a guest:'edit' route (the auth hook rejects
  // before the handler — same as guest publish, see guest-publish.test.ts "hook rejects → 401").
  expect(status).toBe(401);
  expect(await publishedMd(pageId)).toContain("- [ ] guest ship it"); // unchanged
});

test("#317 guest × Reading (edit link): the checkbox flips the draft (#314 parity for guests)", async ({ browser }) => {
  const member = await (await browser.newContext()).newPage();
  await openDemo(member);
  const pageId = await newPageWithTask(member, "guest-cb-reading");
  const url = await shareUrl(pageId, "edit");

  const guest = await (await browser.newContext()).newPage();
  await guest.goto(url);
  await guest.waitForSelector("[data-pane=preview] .cm-content");
  // #941: fixed sleeps here (800/600/300ms) assumed the shared stack always keeps up. Inside the
  // 20-spec merge gate it does not — the checkbox widget renders from a collab sync that shares the
  // stack with 19 other specs' fixtures, and a flat delay that is generous alone is not generous
  // under that load. Each step below waits for the box ITSELF (Playwright's own retrying assert,
  // default 5s, raised here since collab sync — not just paint — is what it is waiting through)
  // rather than for a clock, both on first render and again after each mode switch (the box is a
  // different render each time: edit view, then Reading).
  await expect(guest.getByTestId("task-checkbox")).toBeVisible({ timeout: 10_000 });
  await guest.click("[data-testid=edit-toggle]");
  await guest.waitForSelector("[data-pane=preview] .cm-content");
  await expect(guest.getByTestId("task-checkbox")).toBeVisible({ timeout: 10_000 });
  await guest.getByTestId("displaymode-reading").click();

  const box = guest.getByTestId("task-checkbox");
  await expect(box).toBeVisible({ timeout: 10_000 });
  await expect(box).toBeEnabled(); // #314: Reading blocks prose edits, not task ticks
  await box.click();
  await expect(box).toBeChecked(); // the draft flipped (a normal Y.Text edit over guest collab)
});
