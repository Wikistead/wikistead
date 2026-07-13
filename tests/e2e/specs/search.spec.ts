import { test, expect, type Page } from "@playwright/test";
import { openDemo, sleep, publishAndWait } from "../helpers";
import { STALE_TITLE } from "../fixtures";

const API = "http://dev.localhost:4010";

async function typeSearch(page: Page, q: string) {
  // #285: search is a MODAL now — the header trigger (or Ctrl-K) opens it; the input lives inside.
  if ((await page.getByTestId("search-input").count()) === 0) await page.getByTestId("search-trigger").click();
  const input = page.locator("[data-testid=search-input]");
  await input.fill("");
  await input.fill(q);
  await sleep(700); // debounce + query
}
const resultsText = (page: Page) => page.$eval("[data-testid=search-results]", (el) => el.innerText).catch(() => "");

test("search: find by title, FGA-excluded title hidden, empty, keyboard", async ({ page }) => {
  await openDemo(page);

  // Create an indexed page via the member API (createPage -> Meili upsert). The
  // title is UNIQUE PER RUN: the e2e Meili index accumulates docs across runs, and a
  // shared title eventually exceeds the search limit (20) so stage-1 returns only
  // OLD docs whose FGA grants are gone (wiped with prior stores) → stage-2 drops all
  // and the fresh page is crowded out. A unique title is the sole match.
  const title = `SEARCHME-${Date.now().toString(36)}`;
  await page.evaluate(async ({ api, title }) => {
    await fetch(`${api}/spaces/demo_space/pages`, {
      method: "POST",
      headers: { Authorization: "Bearer dev-token", "content-type": "application/json" },
      body: JSON.stringify({ title }),
    });
  }, { api: API, title });
  // (1) found by title; (2) selecting navigates. Indexing is async (outbox → Meili);
  // poll the API directly (NOT the UI — re-typing the same query would hit the
  // react-query cache) until the page is indexed, then the UI search fetches it fresh.
  await expect
    .poll(
      () => page.evaluate(async ({ api, q }) => {
        const r = await fetch(`${api}/search?q=${encodeURIComponent(q)}`, { headers: { Authorization: "Bearer dev-token" } });
        return ((await r.json()) as unknown[]).length;
      }, { api: API, q: title }),
      { timeout: 20_000, intervals: [500, 1000, 1000] },
    )
    .toBeGreaterThan(0);
  await typeSearch(page, title);
  await page.waitForSelector("[data-testid=search-item]", { timeout: 5000 });
  expect(await resultsText(page)).toContain(title);
  await page.locator("[data-testid=search-item]").first().click();
  await sleep(500);
  expect(page.url()).toMatch(/\/p\/[0-9a-f-]{36}$/);

  // (3) **SECURITY** a title present in Meili (stage-1 candidate) but lacking an
  // FGA grant (stage-2) must NOT appear in the UI.
  await typeSearch(page, STALE_TITLE);
  await sleep(400);
  expect(await page.locator("[data-testid=search-item]").count()).toBe(0);
  expect(await resultsText(page)).toMatch(/no results/i);

  // (4) genuine no-match
  await typeSearch(page, "QQ-NO-MATCH-QQ");
  expect(await resultsText(page)).toMatch(/no results/i);

  // (5) keyboard ArrowDown + Enter opens a result
  await typeSearch(page, title);
  await page.waitForSelector("[data-testid=search-item]", { timeout: 5000 });
  await page.locator("[data-testid=search-input]").press("ArrowDown");
  await page.locator("[data-testid=search-input]").press("Enter");
  await sleep(500);
  expect(page.url()).toMatch(/\/p\/[0-9a-f-]{36}$/);
});

// #285 / ADR-118: the search MODAL — the selected hit drives a right-hand PREVIEW pane whose data
// comes from the view-gated routes (never Meili stage-1 data): title + #222 metadata + a plain-text
// body excerpt, and a draft badge derived from the view-gated `published` boolean.
test("#285: the search modal shows a preview pane (meta + body excerpt + draft badge)", async ({ page }) => {
  await openDemo(page);
  const title = `PREVIEWME-${Date.now().toString(36)}`;
  const id = await page.evaluate(async ({ api, title }) => {
    const r = await fetch(`${api}/spaces/demo_space/pages`, {
      method: "POST",
      headers: { Authorization: "Bearer dev-token", "content-type": "application/json" },
      body: JSON.stringify({ title }),
    });
    return ((await r.json()) as { id: string }).id;
  }, { api: API, title });
  // author + publish so the preview has body text and no draft badge.
  await page.goto(`/p/${id}?edit=1`);
  await page.waitForSelector("[data-pane=preview] .cm-content");
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.type("preview body 285 unique text");
  await publishAndWait(page, id, "preview body 285 unique text"); // #354: poll the published body, not a fixed sleep
  await expect
    .poll(
      () => page.evaluate(async ({ api, q }) => {
        const r = await fetch(`${api}/search?q=${encodeURIComponent(q)}`, { headers: { Authorization: "Bearer dev-token" } });
        return ((await r.json()) as unknown[]).length;
      }, { api: API, q: title }),
      { timeout: 20_000, intervals: [500, 1000, 1000] },
    )
    .toBeGreaterThan(0);

  // reload: the raw-fetch publish above bypasses the app's query invalidation, so the ["page"] cache
  // from the edit visit still says published:false — a fresh page load reflects the real state.
  await page.reload();
  await page.waitForSelector("[data-testid=search-trigger]");
  await typeSearch(page, title);
  await page.waitForSelector("[data-testid=search-item]", { timeout: 5000 });
  // cmdk highlights the first hit → the preview follows (debounced fetch through view-gated routes). #367: pin
  // the FIRST (auto-highlighted) item to this title before checking the preview — under load the list can still
  // show the previous query's hit for a beat, and the preview follows THAT stale highlight.
  const preview = page.getByTestId("search-preview");
  await expect(page.getByTestId("search-item").first()).toContainText(title, { timeout: 8000 });
  // #367: cmdk's highlighted value drives the preview; under load it doesn't always auto-move to the new first
  // item on a query change (the preview then stays on the previous hit). Hover the target item to set cmdk's
  // value deterministically (hover, not click — click opens the page).
  await page.getByTestId("search-item").first().hover();
  await expect(preview).toContainText(title, { timeout: 12_000 });
  await expect(preview.getByTestId("page-meta")).toBeVisible(); // #222 metadata row
  await expect(preview.getByTestId("search-preview-body")).toContainText("preview body 285 unique text");
  // #285 (B): the body renders through the member read-engine (mountPublishedView), not a plain dump.
  await expect(preview.getByTestId("search-preview-rendered").locator(".cm-content")).toBeVisible();
  await expect(preview.getByTestId("search-preview-draft")).toHaveCount(0); // published → no draft badge
  // #285 (C): each result row shows a space icon (not just the space name text).
  await expect(page.getByTestId("search-item-space").first()).toBeVisible();

  // an UNPUBLISHED page shows the draft badge (view-gated `published` boolean, not manage-gated state).
  const draftTitle = `DRAFTME-${Date.now().toString(36)}`;
  await page.evaluate(async ({ api, title }) => {
    await fetch(`${api}/spaces/demo_space/pages`, {
      method: "POST",
      headers: { Authorization: "Bearer dev-token", "content-type": "application/json" },
      body: JSON.stringify({ title }),
    });
  }, { api: API, title: draftTitle });
  await expect
    .poll(
      () => page.evaluate(async ({ api, q }) => {
        const r = await fetch(`${api}/search?q=${encodeURIComponent(q)}`, { headers: { Authorization: "Bearer dev-token" } });
        return ((await r.json()) as unknown[]).length;
      }, { api: API, q: draftTitle }),
      { timeout: 20_000, intervals: [500, 1000, 1000] },
    )
    .toBeGreaterThan(0);
  await typeSearch(page, draftTitle);
  await page.waitForSelector("[data-testid=search-item]", { timeout: 5000 });
  // #367: the preview was showing the PREVIOUS (PREVIEWME) hit; wait for the list's first item to converge to
  // the draft title before checking the preview, so we don't assert against the stale preview body.
  await expect(page.getByTestId("search-item").first()).toContainText(draftTitle, { timeout: 8000 });
  await page.getByTestId("search-item").first().hover(); // #367: deterministically drive cmdk's preview selection
  await expect(preview).toContainText(draftTitle, { timeout: 12_000 });
  await expect(preview.getByTestId("search-preview-draft")).toBeVisible();
  // #285 (B): a draft (no published body) shows an explicit placeholder, not a broken empty pane.
  await expect(preview.getByTestId("search-preview-unpublished")).toBeVisible();
});

// #285 (review bounce): the 2-pane search modal was cramped at max-w-3xl (768px). Widened to
// max-w-5xl — pin the rendered dialog width on a wide viewport (fails at 3xl).
test("#285 the search modal is wide enough for the 2-pane layout", async ({ browser }) => {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  await openDemo(page);
  await typeSearch(page, "the");
  const dialog = page.locator("[data-slot=dialog-content]");
  await expect(dialog).toBeVisible();
  const w = (await dialog.boundingBox())!.width;
  expect(w, `search modal width ${w}px should be the wide 2-pane size (>900px, not the old 768px)`).toBeGreaterThan(900);
});

// #285 (review bounce): at intermediate viewports (640–1024px) the `sm:max-w-5xl` cap OVERRODE the
// base `max-w-[calc(100%-2rem)]` gutter, so the modal went full-bleed with a 0px side gutter (touching both
// screen edges). The min() cap keeps the 2rem (32px) gutter until the viewport exceeds ~66rem. Pin the left AND
// right gutter at two intermediate widths (both would be ~0 before the fix).
for (const width of [900, 640]) {
  test(`#285 the search modal keeps a side gutter at ${width}px (no full-bleed)`, async ({ browser }) => {
    const page = await (await browser.newContext({ viewport: { width, height: 800 } })).newPage();
    await openDemo(page);
    await typeSearch(page, "the");
    const dialog = page.locator("[data-slot=dialog-content]");
    await expect(dialog).toBeVisible();
    const box = (await dialog.boundingBox())!;
    const leftGutter = box.x;
    const rightGutter = width - (box.x + box.width);
    expect(leftGutter, `left gutter ${leftGutter}px at ${width}px viewport should be ≥12px (was ~0 = full-bleed)`).toBeGreaterThanOrEqual(12);
    expect(rightGutter, `right gutter ${rightGutter}px at ${width}px viewport should be ≥12px (was ~0 = full-bleed)`).toBeGreaterThanOrEqual(12);
  });
}
