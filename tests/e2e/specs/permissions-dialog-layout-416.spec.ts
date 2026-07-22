import { test, expect } from "@playwright/test";
import { openDemo, createScratchPage } from "../helpers";

// #416 the Permissions dialog must NEVER outgrow the viewport — bounded max-h flex column,
// header/footer fixed, ONE scrolling body between them. Pin with a dozen grants (the reported
// real-device overflow) on a real Chromium viewport.
const API = "http://dev.localhost:4010";

test("#416 the dialog stays inside the viewport with 12 grants; Close reachable; body scrolls", async ({ page }) => {
  await openDemo(page);
  const pageId = await page.evaluate(async (api) => {
    const r = await fetch(`${api}/spaces/demo_space/pages`, {
      method: "POST",
      headers: { Authorization: "Bearer dev-token", "content-type": "application/json" },
      body: JSON.stringify({ title: "perms layout page" }),
    });
    const id = (await r.json()).id as string;
    // 12 grants straight through the API — the dialog must absorb them without growing past the viewport.
    for (let i = 0; i < 12; i++) {
      await fetch(`${api}/pages/${id}/access`, {
        method: "POST",
        headers: { Authorization: "Bearer dev-token", "content-type": "application/json" },
        body: JSON.stringify({ grantee: `user:layout-grantee-${i}`, relation: "view" }),
      });
    }
    return id;
  }, API);

  await page.setViewportSize({ width: 1000, height: 640 }); // short viewport = the overflow repro
  await page.goto(`/p/${pageId}`);
  await page.waitForSelector("[data-pane=preview] .cm-content");
  await page.click("[data-testid=page-overflow-trigger]");
  await page.click("[data-testid=permissions-open]");
  const dialog = page.locator("[data-testid=permissions-dialog]");
  await expect(dialog).toBeVisible();
  await expect(page.locator("[data-testid=grant-item]").nth(10)).toHaveCount(1); // grants loaded

  const box = (await dialog.boundingBox())!;
  const viewport = page.viewportSize()!;
  expect(box.y, "dialog top inside the viewport").toBeGreaterThanOrEqual(0);
  expect(box.y + box.height, "dialog bottom inside the viewport").toBeLessThanOrEqual(viewport.height + 1);
  expect(box.x + box.width, "no horizontal overflow").toBeLessThanOrEqual(viewport.width + 1);

  // #460 / ADR-174: the ACTIVE PANEL is the scroller now. The single body scroller took the tab strip
  // with it when it scrolled, which is the one piece of chrome that has to stay put for the tabs to be
  // navigable at all.
  const panel = page.locator("[data-testid=permissions-panel-access]");
  const scroll = await panel.evaluate((el) => ({ scrollH: el.scrollHeight, clientH: el.clientHeight }));
  expect(scroll.scrollH, "panel content overflows into the panel's own scroller").toBeGreaterThan(scroll.clientH);
  // the strip stays where it is while the panel scrolls under it
  const stripBefore = (await page.locator("[data-testid=permissions-tab-access]").boundingBox())!;
  await panel.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await page.waitForTimeout(150);
  const stripAfter = (await page.locator("[data-testid=permissions-tab-access]").boundingBox())!;
  expect(Math.abs(stripAfter.y - stripBefore.y), `the tab strip does not scroll away with the panel (before ${JSON.stringify(stripBefore)} after ${JSON.stringify(stripAfter)} panel ${JSON.stringify(scroll)})`).toBeLessThanOrEqual(4); // sub-pixel: the dialog re-centres by a fraction when the scrollbar appears; a strip that actually scrolled would move by hundreds
  // The inactive panels carry `hidden`, which takes them out of the accessibility tree and out of hit
  // testing — asserted on the attribute rather than on visibility, because Playwright counts an
  // opacity:0 element as visible and would wave through a panel that is merely transparent. Their
  // contents are unmounted too, which is the part that matters: nothing reachable is behind them.
  await expect(page.locator("[data-testid=permissions-panel-restrictions]")).toHaveAttribute("hidden", /.*/);
  await expect(page.locator("[data-testid=permissions-panel-advanced]")).toHaveAttribute("hidden", /.*/);
  await expect(page.locator("[data-testid=restrict-sub]"), "the hidden panel's controls are not mounted").toHaveCount(0);
  // …and the footer Close button is visible and clickable WITHOUT scrolling the page.
  const close = dialog.getByRole("button", { name: /close|閉じる/i }).last();
  await expect(close).toBeVisible();
  await close.click();
  await expect(dialog).toBeHidden();
});

// #460 / ADR-174: the counts that decide what a manager looks at next are read at DIALOG level,
// not inside the tab that lists them. If the restriction query only ran once its own tab was opened,
// the Access tab would say "0 restrictions" about a page that has some — and acting on that reading
// (removing an allowlist entry, publishing) is exactly the kind of one-way mistake a permissions
// dialog exists to prevent. So the badge has to be right before its tab has ever been opened.
test("#460: the Access tab reports the restriction count without the Restrictions tab being opened", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  const pageId = await createScratchPage(page, "perm-tabs-460");
  await page.goto(`/p/${pageId}`);
  await page.waitForSelector("[data-pane=preview] .cm-content");
  // restrict somebody through the API, so the dialog opens against a page that already has one
  const status = await page.evaluate(async (id) => {
    const r = await fetch(`/api/pages/${id}/restrict`, {
      method: "POST", headers: { Authorization: "Bearer dev-token", "content-type": "application/json" },
      body: JSON.stringify({ principal: "user:restricted-460" }),
    });
    return r.status;
  }, pageId);
  expect(status, "seeding a restriction").toBeLessThan(300);

  await page.reload();
  await page.waitForSelector("[data-pane=preview] .cm-content");
  await page.click("[data-testid=page-overflow-trigger]");
  await page.click("[data-testid=permissions-open]");
  await expect(page.locator("[data-testid=permissions-dialog]")).toBeVisible();

  // still on Access — the Restrictions panel has never been mounted
  await expect(page.locator("[data-testid=permissions-panel-access]")).toBeVisible();
  await expect(page.locator("[data-testid=permissions-panel-restrictions]")).toHaveAttribute("hidden", /.*/);
  await expect(page.locator("[data-testid=restrict-item]"), "the restriction list has not been rendered yet").toHaveCount(0);
  await expect(page.locator("[data-testid=permissions-restrict-count]"), "the badge counts what is really there")
    .toHaveText("1");

  // and the tab it points at holds the entry
  await page.click("[data-testid=permissions-tab-restrictions]");
  await expect(page.locator("[data-testid=restrict-item]")).toHaveCount(1);
  // the choice survives a re-open of the SAME page…
  await page.locator("[data-testid=permissions-dialog]").getByRole("button", { name: /close|閉じる/i }).last().click();
  await page.click("[data-testid=page-overflow-trigger]");
  await page.click("[data-testid=permissions-open]");
  await expect(page.locator("[data-testid=permissions-panel-restrictions]"), "the dialog reopens on the tab you left")
    .toBeVisible();
});

// #460 ①②③: the tab-container polish. The dialog height is FIXED so switching tabs never resizes
// it; a tab whose content fits does not raise a scrollbar; and the panel is padded on the left so a
// control's focus ring is not clipped by the scroller. Measured on a real Chromium viewport.
test("#460 the dialog keeps one height across tabs, short tabs don't scroll, the panel is left-padded", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  const pageId = await createScratchPage(page, "perm-height-460");
  await page.setViewportSize({ width: 1000, height: 900 }); // tall enough that the desktop fixed height (560) is not clamped
  await page.goto(`/p/${pageId}`);
  await page.waitForSelector("[data-pane=preview] .cm-content");
  await page.click("[data-testid=page-overflow-trigger]");
  await page.click("[data-testid=permissions-open]");
  const dialog = page.locator("[data-testid=permissions-dialog]");
  await expect(dialog).toBeVisible();

  // ① the height is CONSTANT across all three tabs — the reported "height jumps on every tab" is a fixed
  // height regression: with only max-h the box shrank to each tab's content.
  const heightOn = async (tabKey: string) => {
    await page.click(`[data-testid=permissions-tab-${tabKey}]`);
    await expect(page.locator(`[data-testid=permissions-panel-${tabKey}]`)).toBeVisible();
    await page.waitForTimeout(80); // let any transition settle
    return (await dialog.boundingBox())!.height;
  };
  const hAccess = await heightOn("access");
  const hRestrict = await heightOn("restrictions");
  const hAdvanced = await heightOn("advanced");
  expect(Math.abs(hRestrict - hAccess), `access ${hAccess} vs restrictions ${hRestrict} — height must not jump`).toBeLessThanOrEqual(2);
  expect(Math.abs(hAdvanced - hAccess), `access ${hAccess} vs advanced ${hAdvanced} — height must not jump`).toBeLessThanOrEqual(2);

  // ② a short tab (Restrictions, on a page with no restrictions) fits without raising the panel's scrollbar.
  const restrictScroll = await page.locator("[data-testid=permissions-panel-restrictions]").evaluate((el) => ({ s: el.scrollHeight, c: el.clientHeight }));
  expect(restrictScroll.s, `the short tab content fits (scrollH ${restrictScroll.s} clientH ${restrictScroll.c})`).toBeLessThanOrEqual(restrictScroll.c + 1);

  // ③ the scroller is padded on the left so a focus ring on a flush control is not clipped by overflow.
  const padLeft = await page.locator("[data-testid=permissions-panel-restrictions]").evaluate((el) => parseFloat(getComputedStyle(el).paddingLeft));
  expect(padLeft, "panel has left padding for the focus ring").toBeGreaterThanOrEqual(3);
});

// #460 / ADR-174: freeze and the comment audience moved out of the main list into Advanced. They are
// still one click away and still work — the regrouping is presentational, and this says so in the one
// way that matters: by driving them where they now live.
test("#460: freeze and the comment audience are reachable under Advanced and still apply", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  const pageId = await createScratchPage(page, "perm-advanced-460");
  await page.goto(`/p/${pageId}`);
  await page.waitForSelector("[data-pane=preview] .cm-content");
  await page.click("[data-testid=page-overflow-trigger]");
  await page.click("[data-testid=permissions-open]");
  await expect(page.locator("[data-testid=permissions-dialog]")).toBeVisible();

  // not on the first tab — that is the point of the regrouping
  await expect(page.locator("[data-testid=freeze-row]")).toHaveCount(0);
  await page.click("[data-testid=permissions-tab-advanced]");
  await expect(page.locator("[data-testid=freeze-row]")).toBeVisible();
  await expect(page.locator("[data-testid=page-comment-audience]")).toBeVisible();

  // and freezing from here really freezes: the page reports it back after a reload
  await page.click("[data-testid=freeze-guests]");
  await expect(page.locator("[data-testid=permissions-dialog]")).toBeVisible();
  await expect.poll(async () => page.evaluate(async (id) => {
    const r = await fetch(`/api/pages/${id}`, { headers: { Authorization: "Bearer dev-token" } });
    return ((await r.json()) as { frozen?: string | null }).frozen ?? null;
  }, pageId), { timeout: 8000, message: "the freeze reached the server from the Advanced tab" }).toBe("guests");
});
