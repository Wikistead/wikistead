import { test, expect } from "@playwright/test";
import { sleep } from "../helpers";
import postgres from "postgres";
import { E2E } from "../fixtures";

// #364 / ADR-157: the space HOMEPAGE — member flows in real Chromium.
// - /spaces/:id renders the EMPTY STATE (space-name heading + the write button for edit-capable)
// until a home exists; the button creates-and-points atomically and lands in the editor.
// - the home renders AT the space root with the full page machinery; the sidebar tree EXCLUDES it
// (double-display rule) while the fixed 🏠 Home entry navigates back to it.
// - /p/<home-id> canonicalises to /spaces/:id (one location).
// - switching spaces lands on the space root (§6a).

async function newSpacePage(page: any, name: string): Promise<string> {
  const res = await page.evaluate(async (n: string) => {
    const r = await fetch("/api/spaces", { method: "POST", headers: { authorization: "Bearer dev-token", "content-type": "application/json" }, body: JSON.stringify({ name: n }) });
    return (await r.json()) as { id: string };
  }, name);
  return res.id;
}

test("#364: empty state → write button → home renders at the space root; tree excludes it; redirect canonicalises", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await page.goto("/p/demo");
  await page.waitForSelector("[data-pane=preview] .cm-content");
  const spaceId = await newSpacePage(page, `home364-${Date.now().toString(36)}`);

  // 1) empty state: heading + the write button (dev-token is edit-capable)
  await page.goto(`/spaces/${spaceId}`);
  await expect(page.getByTestId("space-home-empty")).toBeVisible({ timeout: 8000 });
  const btn = page.getByTestId("space-home-create");
  await expect(btn, "edit-capable viewer sees the write button").toBeVisible();

  // 2) create → lands in the editor on the space root, rendering the new home draft
  await btn.click();
  await sleep(1500);
  await expect(page.getByTestId("space-home-empty")).toHaveCount(0);
  await expect(page.locator("[data-pane=preview] .cm-content").first()).toBeVisible({ timeout: 8000 });

  // the pointer is set — grab the home id for the later steps
  const homeId = await page.evaluate(async (sid: string) => {
    const r = await fetch("/api/spaces", { headers: { authorization: "Bearer dev-token" } });
    const body = (await r.json()) as { spaces?: { id: string; homePageId?: string | null }[] } | { id: string; homePageId?: string | null }[];
    const spaces = Array.isArray(body) ? body : (body.spaces ?? []);
    return spaces.find((s) => s.id === sid)?.homePageId ?? null;
  }, spaceId);
  expect(homeId, "spaces list carries the pointer for the creator").toBeTruthy();

  // 3) the sidebar shows the fixed Home entry; the tree does NOT list the home page
  await expect(page.getByTestId("sidebar-home")).toBeVisible();
  const treeIds = await page.evaluate(async (sid: string) => {
    const r = await fetch(`/api/spaces/${sid}/pages`, { headers: { authorization: "Bearer dev-token" } });
    return ((await r.json()) as { id: string }[]).map((p) => p.id);
  }, spaceId);
  expect(treeIds, "the tree route excludes the home").not.toContain(homeId);

  // 3.5)the home's title is DERIVED (space name + locale suffix) and shows NO rename
  // affordance — clicking the title never opens the rename textarea
  const titleEl = page.getByTestId("page-title");
  await expect(titleEl).toBeVisible({ timeout: 8000 });
  const titleTxt = (await titleEl.innerText()).trim();
  expect(titleTxt, "derived from the space name").toContain("home364");
  expect(titleTxt, "carries the locale suffix").toMatch(/ Home$|のホーム$/);
  await titleEl.click();
  await sleep(300);
  await expect(page.getByTestId("page-title-input"), "no rename affordance on the home").toHaveCount(0);

  // 4) /p/<home-id> canonicalises to the space root
  await page.goto(`/p/${homeId}`);
  await page.waitForURL(`**/spaces/${spaceId}`, { timeout: 8000 });

  // 5) second create is refused (409) — the button is gone anyway; assert the API contract
  const second = await page.evaluate(async (sid: string) => {
    const r = await fetch(`/api/spaces/${sid}/home`, { method: "POST", headers: { authorization: "Bearer dev-token" } });
    return r.status;
  }, spaceId);
  expect(second).toBe(409);
});

test("#364 §6a: switching spaces lands on the space root", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await page.goto("/p/demo");
  await page.waitForSelector("[data-pane=preview] .cm-content");
  const spaceId = await newSpacePage(page, `home364-sw-${Date.now().toString(36)}`);
  await page.reload({ waitUntil: "networkidle" });
  await sleep(800);
  // open the switcher and pick the new space
  await page.getByTestId("space-switcher").click();
  await sleep(400);
  await page.getByText(`home364-sw-`, { exact: false }).first().click();
  await page.waitForURL(`**/spaces/${spaceId}`, { timeout: 8000 });
  await expect(page.getByTestId("space-home-empty"), "the space root (empty state) is the landing").toBeVisible();
});

// #364the SUFFIX-DOUBLING regression. A home created before ruling A stored the
// label suffix in `pages.title`; the title band re-applied the label and rendered "<Space>
// ". The band now interpolates the SPACE NAME (the single source the sidebar 🏠 already
// used), so no stored title can double it — pinned here with the exact fixture the earlier pass
// lacked: a home whose STORED title carries the suffix (only a freshly created home was ever
// checked before, and that one is correct by construction).
test("#364a suffix-baked stored title never doubles in the H1 (band reads space.name)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await page.goto("/p/demo");
  await page.waitForSelector("[data-pane=preview] .cm-content");
  const spaceName = `home364dup-${Date.now().toString(36)}`;
  const spaceId = await newSpacePage(page, spaceName);
  const homeId = await page.evaluate(async (sid: string) => {
    const r = await fetch(`/api/spaces/${sid}/home`, { method: "POST", headers: { authorization: "Bearer dev-token" } });
    return ((await r.json()) as { id: string }).id;
  }, spaceId);

  // Bake the suffix into the STORED title, exactly as a pre-ruling home carries it. The API cannot
  // produce this state any more (createSpaceHome stores the bare name and PATCH title is refused),
  // so the fixture is written straight to the row — the point is a legacy row reaching the UI.
  const sql = postgres(E2E.pgAdmin);
  try {
    await sql`UPDATE pages SET title = ${`${spaceName} Home`} WHERE id = ${homeId}`;
  } finally {
    await sql.end();
  }

  await page.goto(`/spaces/${spaceId}`);
  const titleEl = page.getByTestId("page-title");
  await expect(titleEl).toBeVisible({ timeout: 8000 });
  // A RETRYING assertion on the settled text: the pre-fix band interpolated the (suffix-baked)
  // stored title and settles on "<Space> Home Home", so this can only pass by actually reading the
  // space name. (A one-shot innerText would have gone red on the first, still-loading frame — a
  // vacuous red that never distinguishes doubled from single.)
  await expect(titleEl, "H1 = the space name + exactly one suffix").toHaveText(`${spaceName} Home`, { timeout: 8000 });
  const txt = (await titleEl.innerText()).trim();
  expect(txt.match(/Home/g)?.length ?? 0, "one suffix occurrence").toBe(1);

  // the sidebar 🏠 (which always read space.name) and the band now agree — one source, one string
  const homeEntry = (await page.getByTestId("sidebar-home").innerText()).trim();
  expect(homeEntry, "sidebar 🏠 and the title band render the same label").toBe(txt);
});

//every surface names a space's home page after its space — the sidebar's 🏠 row, the member
// band, the empty state — except the GUEST band, which printed the raw title. Migration 077 normalised
// a home page's title to the bare space name, so once it landed the same page read "acme" through a
// share link and "acme Home" one pane away. Driven through a real share link on both capabilities: the
// label matches, and the edit guest is not offered a rename (a home page is named by its space, so
// renaming it here would rename the wrong thing).
for (const capability of ["view", "edit"] as const) {
  test(`#364a ${capability} guest sees the home page labelled by its space`, async ({ browser }) => {
    const page = await (await browser.newContext()).newPage();
    await page.goto("/p/demo");
    await page.waitForSelector("[data-pane=preview] .cm-content");
    const spaceName = `homeguest364-${Date.now().toString(36)}`;
    const spaceId = await newSpacePage(page, spaceName);

    // create the home through the same button a writer uses, then publish it so a guest can read it
    await page.goto(`/spaces/${spaceId}`);
    await page.getByTestId("space-home-create").click();
    await sleep(1500);
    const homeId = await page.evaluate(async (sid: string) => {
      const r = await fetch("/api/spaces", { headers: { authorization: "Bearer dev-token" } });
      const body = (await r.json()) as { spaces?: { id: string; homePageId?: string | null }[] } | { id: string; homePageId?: string | null }[];
    const spaces = Array.isArray(body) ? body : (body.spaces ?? []);
      return spaces.find((s) => s.id === sid)?.homePageId ?? null;
    }, spaceId);
    expect(homeId, "the space has a home page").toBeTruthy();

    // the home's title is written as part of creating it; wait for it to be there rather than racing it
    await expect.poll(async () => page.evaluate(async (id: string) => {
      const r = await fetch(`/api/pages/${id}`, { headers: { authorization: "Bearer dev-token" } });
      return ((await r.json()) as { title?: string }).title ?? "";
    }, homeId!), { timeout: 10000, message: "the home page's stored title settles" }).not.toBe("");

    const made = await page.evaluate(async ([id, cap]: string[]) => {
      const h = { authorization: "Bearer dev-token", "content-type": "application/json" };
      const pub = await fetch(`/api/pages/${id}/publish`, { method: "POST", headers: h, body: "{}" });
      const title = ((await (await fetch(`/api/pages/${id}/published`, { headers: h })).json()) as { title?: string }).title ?? null;
      const r = await fetch("/api/share-links", {
        method: "POST", headers: h,
        body: JSON.stringify({ resource: { type: "page", id }, capability: cap, expiresInSeconds: null }),
      });
      return { publish: pub.status, title, linkId: ((await r.json()) as { id?: string }).id ?? null };
    }, [homeId!, capability]);
    expect(made.linkId, `a share link was created (publish ${made.publish}, stored title ${JSON.stringify(made.title)})`).toBeTruthy();
    const linkId = made.linkId;

    const guest = await (await browser.newContext()).newPage();
    await guest.goto(`/share/${linkId}`);
    const band = guest.getByTestId("guest-title-band");
    await expect(band).toBeVisible({ timeout: 12000 });
    // the band renders its placeholder first and fills in when the fetch lands, so poll for the real
    // label rather than reading once — "Untitled" is non-empty and would satisfy a laxer wait
    await expect.poll(async () => (await band.innerText()).trim(), { timeout: 12000, message: `the guest band resolves its title (member stored ${JSON.stringify(made.title)}, publish ${made.publish})` })
      .toContain(spaceName);
    const label = (await band.innerText()).trim();
    expect(label, `…and it carries the home suffix the other surfaces use (got "${label}")`).toMatch(/ Home$|のホーム$/);

    if (capability === "edit") {
      await band.click();
      await sleep(300);
      await expect(guest.getByTestId("page-title-input"), "a home page offers no rename, even to an edit guest").toHaveCount(0);
    }
  });
}

// #364①: the sidebar follows a DIRECT /spaces/:id link even when the space has no home. The
// active-space sync used to be page-driven only, and the home-less empty state opens no page — so the
// sidebar silently stayed on whatever space was active before (the reported "sidebar stuck on Demo Space").
test("#364a direct link to a home-less space moves the sidebar to that space", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  // land somewhere in the DEFAULT space first, so the sidebar has a previous active space to be stuck on
  await page.goto("/p/demo");
  await page.waitForSelector("[data-pane=preview] .cm-content");
  const name = `home364nosync-${Date.now().toString(36)}`;
  const spaceId = await newSpacePage(page, name);

  await page.goto(`/spaces/${spaceId}`);
  await expect(page.getByTestId("space-home-empty")).toBeVisible({ timeout: 8000 });
  // the empty state opened NO page — the sidebar must still follow the URL's space
  await expect(page.getByTestId("space-switcher"), "the sidebar switched to the space in the URL").toContainText(name, { timeout: 8000 });
});
