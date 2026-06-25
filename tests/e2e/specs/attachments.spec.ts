import { test, expect } from "@playwright/test";
import { openDemo, sleep } from "../helpers";
import { LOCKED_SPACE_ID, LOCKED_PAGE_ID } from "../fixtures";

const API = "http://dev.localhost:4010";

test("attachments: upload -> confirm -> download, and unauthorized page is forbidden", async ({ page, request }) => {
  await openDemo(page);

  // open the attachments panel from the ⋯ menu, then upload (presign -> PUT -> confirm)
  await page.click("[data-testid=page-overflow-trigger]");
  await page.click("[data-testid=attachments-toggle]");
  await expect(page.getByTestId("attachments-panel")).toBeVisible();
  await sleep(200);
  await page.setInputFiles("[data-testid=attachments-panel] input[type=file]", {
    name: "hello-e2e.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("hello from e2e"),
  });
  // the uploaded file appears in the list (robust to any pre-existing items)
  await page.waitForFunction(
    () => [...document.querySelectorAll("[data-testid=attach-item]")].some((e) => (e as HTMLElement).innerText.includes("hello-e2e.txt")),
    undefined,
    { timeout: 8000 },
  );

  // (1) download path: GET /download re-checks FGA `view` and issues a fresh
  // presigned GET URL (the app opens it via navigation/window.open). We fetch the
  // storage URL with Playwright's node-side request (the real app uses a top-level
  // navigation, so neither path needs CORS-on-response from the gateway).
  const downloadUrl = await page.evaluate(async (api) => {
    const list = await (await fetch(`${api}/spaces/demo_space/pages/demo/attachments`, { headers: { Authorization: "Bearer dev-token" } })).json();
    const mine = list.find((a: { filename: string }) => a.filename === "hello-e2e.txt");
    const meta = await (await fetch(`${api}/attachments/${mine.id}/download`, { headers: { Authorization: "Bearer dev-token" } })).json();
    return meta.downloadUrl as string;
  }, API);
  const body = await request.get(downloadUrl);
  expect(body.status()).toBe(200);
  expect(await body.text()).toBe("hello from e2e");

  // (2) **SECURITY** on a page the user can't access (locked: in Postgres via RLS,
  // no FGA grant), uploading (edit) and listing (view) are both forbidden.
  const forbidden = await page.evaluate(async ({ api, space, pageId }) => {
    const presign = await fetch(`${api}/spaces/${space}/pages/${pageId}/attachments/presign`, {
      method: "POST",
      headers: { Authorization: "Bearer dev-token", "content-type": "application/json" },
      body: JSON.stringify({ filename: "x.txt", contentType: "text/plain" }),
    });
    const listing = await fetch(`${api}/spaces/${space}/pages/${pageId}/attachments`, { headers: { Authorization: "Bearer dev-token" } });
    return { presign: presign.status, list: listing.status };
  }, { api: API, space: LOCKED_SPACE_ID, pageId: LOCKED_PAGE_ID });
  expect(forbidden.presign).toBe(403); // upload (edit) denied
  expect(forbidden.list).toBe(403); // list/URLs (view) denied
});
