import { test, expect, type Page, type Browser } from "@playwright/test";
import { openDemo, resetDoc, paneText, sleep } from "../helpers";

const API = "http://dev.localhost:4010";

async function ensureExpanded(page: Page) {
  if (!(await page.getByText("Demo Page", { exact: true }).count())) {
    await page.getByText("Demo Space", { exact: true }).click();
    await sleep(300);
  }
}
async function createLink(page: Page, capability: "view" | "edit"): Promise<string> {
  await ensureExpanded(page);
  await page.evaluate(() => document.querySelector('[data-testid=sidebar] button[aria-label="Share page"]')?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  await page.waitForSelector("[data-testid=share-dialog]");
  await page.selectOption('[data-testid=share-dialog] select[aria-label="Capability"]', capability);
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
  await resetDoc(member);

  // member creates an EDIT link
  const editUrl = await createLink(member, "edit");
  expect(editUrl).toMatch(/\/share\/[0-9a-f-]{36}$/);

  // anonymous guest opens it and can edit
  const guest = await (await browser.newContext()).newPage();
  await guest.goto(editUrl);
  await guest.waitForSelector("[data-pane=preview] .cm-content", { timeout: 10000 });
  await sleep(1000);
  expect(await guest.$eval("[data-pane=preview] .cm-content", (el) => el.getAttribute("contenteditable"))).toBe("true");

  // guest edit syncs to member (anonymous co-editing)
  await guest.click("[data-pane=preview] .cm-content");
  await guest.keyboard.type("from-guest");
  await sleep(600);
  expect(await paneText(member, "source")).toContain("from-guest");

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
