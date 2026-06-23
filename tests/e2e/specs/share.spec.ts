import { test, expect, type Page, type Browser } from "@playwright/test";
import { openDemo, resetDoc, paneText, enterSplit, enterEdit, sleep } from "../helpers";

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
  await page.waitForSelector("[data-testid=share-dialog]");
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

test("anonymous share: create -> open -> co-edit -> read-only -> revoke denied", async ({ browser }: { browser: Browser }) => {
  const member = await (await browser.newContext()).newPage();
  await openDemo(member);
  // P3: editor defaults to read-only view; the member edits + reads the source
  // pane below, so open the editable split.
  await enterSplit(member);
  await resetDoc(member);

  // member creates an EDIT link
  const editUrl = await createLink(member, "edit");
  expect(editUrl).toMatch(/\/share\/[0-9a-f-]{36}$/);

  // anonymous guest opens it and can edit
  const guest = await (await browser.newContext()).newPage();
  await guest.goto(editUrl);
  await guest.waitForSelector("[data-pane=preview] .cm-content", { timeout: 10000 });
  await sleep(1000);
  // Edit-capable guest: reveal the editable surface (defaults to view).
  await enterEdit(guest);
  expect(await guest.$eval("[data-pane=preview] .cm-content", (el) => el.getAttribute("contenteditable"))).toBe("true");

  // guest edit syncs to member (anonymous co-editing)
  await guest.click("[data-pane=preview] .cm-content");
  await guest.keyboard.type("from-guest");
  await sleep(600);
  expect(await paneText(member, "preview")).toContain("from-guest");

  // a VIEW link is read-only
  await member.bringToFront();
  const viewUrl = await createLink(member, "view");
  const viewer = await (await browser.newContext()).newPage();
  await viewer.goto(viewUrl);
  await viewer.waitForSelector("[data-pane=preview] .cm-content", { timeout: 10000 });
  await sleep(800);
  expect(await viewer.$eval("[data-pane=preview] .cm-content", (el) => el.getAttribute("contenteditable"))).toBe("false");

  // revoke the edit link (authenticated API) -> a fresh guest is denied
  const editId = editUrl.split("/").pop()!;
  const status = await member.evaluate(async ({ id, api }) => {
    const r = await fetch(`${api}/share-links/${id}`, { method: "DELETE", headers: { Authorization: "Bearer dev-token" } });
    return r.status;
  }, { id: editId, api: API });
  expect(status).toBe(204);

  const denied = await (await browser.newContext()).newPage();
  await denied.goto(editUrl);
  await sleep(1500);
  expect(await denied.evaluate(() => document.body.innerText)).toMatch(/invalid, expired, or revoked/i);
});
