import { test, expect, type Page, type Browser } from "@playwright/test";
import { openDemo, resetDoc, paneText, enterSplit, enterEdit } from "../helpers";

const API = "http://dev.localhost:4010";

async function ensureExpanded(page: Page) {
  // Active space follows the open page (demo), so the demo row is already in the
  // sidebar tree — just wait for it (no space-expand; that would open the switcher).
  await page.waitForSelector("[data-testid=tree-page]", { timeout: 5000 });
}
async function createLink(page: Page, capability: "view" | "edit"): Promise<string> {
  await ensureExpanded(page);
  // Open the demo row's "…" menu and pick Share.
  const row = page.locator("[data-testid=tree-page]", { hasText: "Demo Page" }).first();
  await row.hover();
  await row.locator("[data-testid=page-actions]").click();
  await page.locator("[data-testid=page-menu][data-state=open]").getByText("Share").click();
  await page.waitForSelector("[data-testid=share-dialog]", { timeout: 10000 });
  // Two ShareDialog instances mount (sidebar + page route); only the open one is
  // visible, so scope the Select to the visible trigger.
  await page.locator("[data-testid=share-capability]:visible").click();
  await page.locator(`[data-testid=share-capability-${capability}]:visible`).click();
  const before = await page.$$eval('[data-testid=share-dialog] input[aria-label="Share URL"]', (e) => e.length);
  await page.click("[data-testid=create-link]");
  await page.waitForFunction((n) => document.querySelectorAll('[data-testid=share-dialog] input[aria-label="Share URL"]').length > n, before, { timeout: 5000 });
  const want = capability === "edit" ? "Edit" : "View";
  const url = await page.evaluate((w) => {
    const rows = [...document.querySelectorAll("[data-testid=share-dialog] input[aria-label='Share URL']")].map((inp) => ({ url: (inp as HTMLInputElement).value, meta: (inp.closest("div")?.textContent ?? "") }));
    return (rows.find((r) => r.meta.includes(w)) ?? rows[0])?.url ?? "";
  }, want);
  await page.keyboard.press("Escape");
  return url;
}

// #470: this spec drives THREE browser contexts through a live collab session, so its cost tracks how
// busy the stack already is — run third behind other specs it used to hit the 60s wall and read as a
// regression. Every wait below is now a condition with its own budget and message, so the run is as
// fast as the stack allows and a genuine failure names the step instead of expiring anonymously.
test("anonymous share: create -> open -> co-edit -> read-only -> revoke denied", async ({ browser }: { browser: Browser }) => {
  test.slow(); // triples the budget: three contexts + collab propagation is legitimately slow work
  const member = await (await browser.newContext()).newPage();
  await openDemo(member);
  // P3: editor defaults to read-only view; the member edits + reads the source
  // pane below, so open the editable split.
  await enterSplit(member);
  await resetDoc(member);
  // #470: a marker the guest must SEE before we ask it to type. The old fixed second was the only
  // thing standing between "the guest's editor exists" and "the collab channel is live"; waiting for
  // real content proves the channel instead of hoping, and costs nothing on a warm stack.
  await member.keyboard.type("seed-470");

  // member creates an EDIT link
  const editUrl = await createLink(member, "edit");
  expect(editUrl).toMatch(/\/share\/[0-9a-f-]{36}$/);

  // anonymous guest opens it and can edit
  const guest = await (await browser.newContext()).newPage();
  await guest.goto(editUrl);
  await guest.waitForSelector("[data-pane=preview] .cm-content", { timeout: 10000 });
  // Edit-capable guest: reveal the editable surface (defaults to view — the read view shows the
  // PUBLISHED text, so the live doc only appears once we are in edit).
  await enterEdit(guest);
  expect(await guest.$eval("[data-pane=preview] .cm-content", (el) => el.getAttribute("contenteditable"))).toBe("true");
  // #470: wait for the DOC to arrive over collab, not for a fixed second. Under load the sleep was
  // both too short (flake) and, on a warm stack, pure dead time — and when it did run out the test
  // failed later, at an assertion that named the wrong step.
  await expect.poll(() => paneText(guest, "preview"), { timeout: 20000, message: "the guest received the live doc over collab" })
    .toContain("seed-470");

  // guest edit syncs to member (anonymous co-editing)
  await guest.click("[data-pane=preview] .cm-content");
  await guest.keyboard.type("from-guest");
  await expect.poll(() => paneText(member, "preview"), { timeout: 20000, message: "the guest's edit reached the member (anonymous co-editing)" })
    .toContain("from-guest");

  // a VIEW link is read-only. asserting contenteditable alone proved nothing here — a viewer
  // that never enters edit mode renders the read surface, which is contenteditable="false" whatever
  // capability the link carries, so the assertion held even if a view link were handed edit rights.
  // Check the capability itself, on both layers: the UI must not offer the affordance, and the server
  // must not accept the write even if it did.
  await member.bringToFront();
  const viewUrl = await createLink(member, "view");
  const viewer = await (await browser.newContext()).newPage();
  await viewer.goto(viewUrl);
  await viewer.waitForSelector("[data-pane=preview] .cm-content", { timeout: 10000 });
  await expect.poll(() => viewer.$eval("[data-pane=preview] .cm-content", (el) => el.getAttribute("contenteditable")),
    { timeout: 15000, message: "a view link stays read-only" }).toBe("false");
  // the edit affordance is rendered from canEdit, so its absence IS the client-side capability
  await expect(viewer.locator("[data-testid=edit-toggle]"), "a view guest is not offered the edit button")
    .toHaveCount(0);
  await expect(viewer.locator("[data-testid=m-edit-toggle]"), "…nor the overflow-menu entry").toHaveCount(0);
  // and the fortress: type into the surface anyway and require that nothing reaches the shared doc.
  // The member is live on the same page, so a leak would surface there within the collab round-trip
  // we already measured above (the guest's own edit landed well inside 20s).
  await viewer.click("[data-pane=preview] .cm-content");
  await viewer.keyboard.type("viewer-must-not-write");
  await viewer.waitForTimeout(3000); // a NEGATIVE assertion: give a leak time to appear (#470 kept the
  // positive waits poll-based; there is nothing to poll for when the requirement is that nothing happens)
  expect(await paneText(viewer, "preview"), "a view guest's typing must not enter the document").not.toContain("viewer-must-not-write");
  expect(await paneText(member, "preview"), "a view guest's typing must never reach the member's doc").not.toContain("viewer-must-not-write");

  // revoke the edit link (authenticated API) -> a fresh guest is denied
  const editId = editUrl.split("/").pop()!;
  const status = await member.evaluate(async ({ id, api }) => {
    const r = await fetch(`${api}/share-links/${id}`, { method: "DELETE", headers: { Authorization: "Bearer dev-token" } });
    return r.status;
  }, { id: editId, api: API });
  expect(status).toBe(204);

  const denied = await (await browser.newContext()).newPage();
  await denied.goto(editUrl);
  await expect.poll(() => denied.evaluate(() => document.body.innerText),
    { timeout: 15000, message: "the revoked link is refused" }).toMatch(/invalid, expired, or revoked/i);
});
