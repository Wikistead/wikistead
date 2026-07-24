import { test, expect } from "@playwright/test";
import { openScratch, enterEdit, sleep, API } from "../helpers";
// #437 / ADR-167: delete_mode UI pins.
//  - default (trash_only): the ⋯ menu offers "Move to trash" only — no permanent entry.
//  - both: BOTH entries; the permanent path opens a TYPED confirmation (button disabled until the
//    page title is typed) and permanently deletes (no trash entry appears).
//  - direct_only: the trash entry disappears; the trash ROUTE 400s (server gate, checked via API).
// The mode is set through the real admin/space APIs; reset to inherit/trash_only at the end.

const setSpaceMode = async (page: import("@playwright/test").Page, spaceId: string, mode: string | null) => {
  const res = await page.request.put(`${API}/spaces/${spaceId}/delete-mode`, {
    headers: { authorization: "Bearer dev-token", "content-type": "application/json" },
    data: { deleteMode: mode },
  });
  expect(res.ok()).toBeTruthy();
};

test("#437: delete menu follows the resolved mode; the permanent path is typed-confirmed", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  const pageId = await openScratch(page, "dm437-ui");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("delete mode target\n");
  await sleep(600);
  // resolve the spaceId from the page payload
  const pageInfo = await (await page.request.get(`${API}/pages/${pageId}`, { headers: { authorization: "Bearer dev-token" } })).json();
  const spaceId = pageInfo.spaceId as string;
  try {
    // default (trash_only): trash entry only
    await page.getByTestId("page-overflow-trigger").click();
    await sleep(300);
    await expect(page.getByTestId("delete-page")).toHaveCount(1);
    await expect(page.getByTestId("delete-page-forever")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await sleep(200);

    // both: two entries; the permanent dialog gates on typing the title
    await setSpaceMode(page, spaceId, "both");
    await page.reload({ waitUntil: "networkidle" });
    await sleep(800);
    await page.getByTestId("page-overflow-trigger").click();
    await sleep(300);
    await expect(page.getByTestId("delete-page")).toHaveCount(1);
    await expect(page.getByTestId("delete-page-forever")).toHaveCount(1);
    await page.getByTestId("delete-page-forever").click();
    await sleep(400);
    const confirmBtn = page.getByTestId("confirm-delete-page-forever");
    await expect(confirmBtn).toBeDisabled(); // typed confirmation gates the irreversible path
    const title = (pageInfo.title as string) || "Untitled";
    await page.getByTestId("typed-confirm-input").fill(title);
    await expect(confirmBtn).toBeEnabled();
    await confirmBtn.click();
    await sleep(900);
    // permanently gone: the API 403/404s the page and the space trash does NOT list it
    const gone = await page.request.get(`${API}/pages/${pageId}`, { headers: { authorization: "Bearer dev-token" } });
    expect(gone.ok()).toBeFalsy();
    const trash = await (await page.request.get(`${API}/spaces/${spaceId}/trash`, { headers: { authorization: "Bearer dev-token" } })).json();
    expect((trash as Array<{ id: string }>).some((e) => e.id === pageId)).toBe(false);
  } finally {
    // leave no residue: other specs (sidebar-delete-275) assert an EMPTY scratch tree
    await page.request.delete(`${API}/pages/${pageId}/permanent`, { headers: { authorization: "Bearer dev-token" } }).catch(() => {});
    await setSpaceMode(page, spaceId, null);
  }
});

test("#437: direct_only hides the trash entry and the trash route 400s (server gate)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  const pageId = await openScratch(page, "dm437-ui2");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("direct only target\n");
  await sleep(600);
  const pageInfo = await (await page.request.get(`${API}/pages/${pageId}`, { headers: { authorization: "Bearer dev-token" } })).json();
  const spaceId = pageInfo.spaceId as string;
  try {
    await setSpaceMode(page, spaceId, "direct_only");
    await page.reload({ waitUntil: "networkidle" });
    await sleep(800);
    await page.getByTestId("page-overflow-trigger").click();
    await sleep(300);
    await expect(page.getByTestId("delete-page")).toHaveCount(0); // the trash entry is gone
    await expect(page.getByTestId("delete-page-forever")).toHaveCount(1);
    await page.keyboard.press("Escape");
    // the server gate: the trash ROUTE 400s with the static policy reason (after FGA — dev-token manages)
    const res = await page.request.delete(`${API}/pages/${pageId}`, { headers: { authorization: "Bearer dev-token" } });
    expect(res.status()).toBe(400);
    const body = await res.json();
    // fastify's default serialization carries the STATIC message (custom props are dropped) — the
    // policy 400 must stay static/no-detail either way (no oracle).
    expect(String(body.message ?? "")).toContain("disabled by policy");
  } finally {
    await page.request.delete(`${API}/pages/${pageId}/permanent`, { headers: { authorization: "Bearer dev-token" } }).catch(() => {});
    await setSpaceMode(page, spaceId, null);
  }
});
