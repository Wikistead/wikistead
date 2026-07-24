import { test, expect } from "@playwright/test";
import { openDemo, sleep, API } from "../helpers";
import { E2E } from "../fixtures";

// P2 UX proof in a REAL browser: searching a mid-text Japanese keyword shows a
// body snippet that renders correctly (no mojibake) and is cropped around the
// match — the part only a real browser confirms. Server anti-tests already cover
// CJK matching + the two-stage guard (snippet never leaks for unauthorized docs);
// this covers rendering.
async function meiliUpsert(doc: Record<string, unknown>) {
  await fetch(`${E2E.meili}/indexes/${E2E.index}/documents`, {
    method: "POST",
    headers: { Authorization: `Bearer ${E2E.meiliKey}`, "content-type": "application/json" },
    body: JSON.stringify([doc]),
  });
}

async function meiliDoc(id: string): Promise<Record<string, unknown> | null> {
  const r = await fetch(`${E2E.meili}/indexes/${E2E.index}/documents/${id}`, {
    headers: { Authorization: `Bearer ${E2E.meiliKey}` },
  });
  return r.ok ? ((await r.json()) as Record<string, unknown>) : null;
}

// Poll until `pred` holds (or we give up). Fixed sleeps are racy here: createPage
// fires an ASYNC outbox reindex that rewrites this doc with the page's PUBLISHED
// body (empty for a draft) — if it lands after our manual upsert it clobbers the
// injected Japanese body. So we (1) wait for that create-reindex to land, then
// (2) upsert, then (3) confirm the upsert stuck before searching.
async function poll(pred: () => Promise<boolean>, tries = 40, gap = 250) {
  for (let i = 0; i < tries; i++) {
    if (await pred()) return;
    await sleep(gap);
  }
  throw new Error("poll: condition never became true");
}

test("searching Japanese shows a correctly-rendered body snippet", async ({ page }) => {
  await openDemo(page);

  // Create a page dev-user can view: post-4a a new page is a DRAFT (no page#space),
  // but createPage grants the CREATOR direct `manage` (→ view), so the two-stage
  // guard's FGA stage passes for dev-user on this page.
  const id = await page.evaluate(async ({ api }) => {
    const r = await fetch(`${api}/spaces/demo_space/pages`, {
      method: "POST",
      headers: { Authorization: "Bearer dev-token", "content-type": "application/json" },
      body: JSON.stringify({ title: "CJKSNIPPETPAGE" }),
    });
    return (await r.json()).id as string;
  }, { api: API });

  // Wait for createPage's async (empty-body) reindex to land FIRST, then overwrite
  // the doc with a Japanese body — otherwise that late reindex clobbers our body.
  // Latin title forces the query to match the BODY only.
  const JP_BODY = "新宿区にある東京都庁についてのまとめwiki本文スニペット表示テストです。";
  // #367: under parallel load the create-reindex and the upsert reflection both take longer, so poll generously
  // (60×250ms = 15s) instead of the default 10s.
  await poll(async () => (await meiliDoc(id)) !== null, 60);
  await meiliUpsert({
    id, tenantId: E2E.tenant, spaceId: "demo_space", title: "CJKSNIPPETPAGE",
    body: JP_BODY,
    viewerUsers: ["user:dev-user"], viewerGroups: [], isPublic: false, updatedAt: Date.now(),
  });
  // Confirm the injected body stuck (no further reindex raced past it) before searching.
  await poll(async () => (await meiliDoc(id))?.body === JP_BODY, 60);

  // Search a mid-text Japanese keyword (matches the body, not the latin title).
  await page.getByTestId("search-trigger").click(); // #285: search lives in the modal now
  const input = page.locator("[data-testid=search-input]");
  // #367: the UI issues ONE debounced fetch per query change — if that fetch fires before Meili has the doc
  // visible under load, the list stays empty and never auto-retries. RE-issue the query each poll iteration
  // (clear + refill) until a hit appears, instead of a single fixed sleep(800) + one waitForSelector.
  await expect
    .poll(async () => {
      await input.fill("");
      await input.fill("東京都");
      return page.getByTestId("search-item").count();
    }, { timeout: 20_000, intervals: [600, 800, 1000, 1000] })
    .toBeGreaterThan(0);

  const snippet = page.locator("[data-testid=search-snippet]").first();
  await expect(snippet).toBeVisible();
  // Japanese renders correctly and the crop includes the matched term in context.
  await expect(snippet).toContainText("東京都庁", { timeout: 8000 });
});
