import { test, expect } from "@playwright/test";
import { openDemo, sleep } from "../helpers";
import { E2E } from "../fixtures";

// P2 UX proof in a REAL browser: searching a mid-text Japanese keyword shows a
// body snippet that renders correctly (no mojibake) and is cropped around the
// match — the part only a real browser confirms. Server anti-tests already cover
// CJK matching + the two-stage guard (snippet never leaks for unauthorized docs);
// this covers rendering.
const API = "http://dev.localhost:4010";

async function meiliUpsert(doc: Record<string, unknown>) {
  await fetch(`${E2E.meili}/indexes/${E2E.index}/documents`, {
    method: "POST",
    headers: { Authorization: `Bearer ${E2E.meiliKey}`, "content-type": "application/json" },
    body: JSON.stringify([doc]),
  });
}

test("searching Japanese shows a correctly-rendered body snippet", async ({ page }) => {
  await openDemo(page);

  // Create a page dev-user can view (createPage writes the FGA space-inheritance
  // tuple, so the two-stage guard's FGA stage passes for this page).
  const id = await page.evaluate(async ({ api }) => {
    const r = await fetch(`${api}/spaces/demo_space/pages`, {
      method: "POST",
      headers: { Authorization: "Bearer dev-token", "content-type": "application/json" },
      body: JSON.stringify({ title: "CJKSNIPPETPAGE" }),
    });
    return (await r.json()).id as string;
  }, { api: API });

  // Let createPage's async (empty-body) Meili upsert settle, THEN overwrite the
  // doc with a Japanese body. Latin title forces the query to match the BODY only.
  await sleep(2000);
  await meiliUpsert({
    id, tenantId: E2E.tenant, spaceId: "demo_space", title: "CJKSNIPPETPAGE",
    body: "新宿区にある東京都庁についてのまとめwiki本文スニペット表示テストです。",
    viewerUsers: ["user:dev-user"], viewerGroups: [], isPublic: false, updatedAt: Date.now(),
  });
  await sleep(1500);

  // Search a mid-text Japanese keyword (matches the body, not the latin title).
  const input = page.locator("[data-testid=search-input]");
  await input.click();
  await input.fill("");
  await input.fill("東京都");
  await sleep(800);

  await page.waitForSelector("[data-testid=search-item]", { timeout: 5000 });
  const snippet = page.locator("[data-testid=search-snippet]").first();
  await expect(snippet).toBeVisible();
  // Japanese renders correctly and the crop includes the matched term in context.
  await expect(snippet).toContainText("東京都庁");
});
