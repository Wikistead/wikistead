import { test, expect, type Page } from "@playwright/test";
import { enterEdit, openScratch, sleep } from "../helpers";

const API = "http://dev.localhost:4010";
const publish = (p: Page, id: string) =>
  p.evaluate(async ({ api, id }) => { await fetch(`${api}/pages/${id}/publish`, { method: "POST", headers: { Authorization: "Bearer dev-token" } }); }, { api: API, id });

// #90 / #337 (ADR-043, option A): :::details has a real open/close model as ONE box that GROWS. Collapsed →
// a summary bar (arrow ▸); clicking the bar TOGGLES the body open/closed (display-only, animated height, NOT
// raw); editing (raw reveal) is reached via the hover ✎ / Ctrl+Enter.
test(":::details toggles a rendered body open/closed from the summary bar (display-only, not raw)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "details");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(":::details[More info]\nthe hidden body\n:::\n\nbelow\n");
  await sleep(400);

  const box = page.locator("[data-pane=preview] [data-testid=macro-details]");
  const bar = page.locator("[data-pane=preview] [data-testid=details-summary-bar]");
  const body = page.locator("[data-pane=preview] [data-testid=details-body]");
  await expect(bar).toBeVisible();
  await expect(bar).toContainText("More info");
  // Collapsed: the box is not in the open state; the body row is clipped to ~0 height (single glyph rotates,
  // no ▸/▾ text swap, so we assert the open CLASS + geometry, not the arrow char).
  await expect(box).not.toHaveClass(/cm-lp-details-open/);
  expect((await body.boundingBox())?.height ?? 999, "collapsed body is ~0 height").toBeLessThan(4);

  // Click the bar → OPEN: the box grows, the body renders (NOT the raw directive source).
  await bar.click();
  await sleep(350); // height animation
  await expect(box).toHaveClass(/cm-lp-details-open/);
  expect((await body.boundingBox())!.height, "opened body has real height").toBeGreaterThan(8);
  const opened = await page.locator("[data-pane=preview] .cm-content").innerText();
  expect(opened).toContain("the hidden body");
  expect(opened).not.toContain(":::details"); // rendered body, not raw reveal

  // Click again → CLOSED: the box shrinks back.
  await bar.click();
  await sleep(350);
  await expect(box).not.toHaveClass(/cm-lp-details-open/);
  expect((await body.boundingBox())?.height ?? 999, "re-collapsed body is ~0 height").toBeLessThan(4);
});

// #337 point 1: the toggle is display-only, so it must work on the READ-ONLY surfaces too (view / Reading) —
// the old code wired the toggle only inside the `!readOnly` guard, so a published/viewed details couldn't open.
test("#337: :::details opens in VIEW and Reading mode (read-only surfaces), not just Live", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  const pageId = await openScratch(page, "details-ro");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(":::details[More info]\nthe hidden body\n:::\n\nbelow\n");
  await sleep(400);
  await publish(page, pageId);

  for (const mode of ["view", "reading"] as const) {
    if (mode === "view") await page.click("[data-testid=view-toggle]");
    else { await page.click("[data-testid=edit-toggle]"); await sleep(300); await page.getByTestId("displaymode-reading").click(); }
    await sleep(400);
    const box = page.locator("[data-pane=preview] [data-testid=macro-details]").first();
    const bar = page.locator("[data-pane=preview] [data-testid=details-summary-bar]").first();
    await expect(box).toBeVisible();
    // The open state persists across mode switches (module-level, keyed by block pos), so don't assume the
    // start state — assert that a bar CLICK on this read-only surface TOGGLES it (the old bug: no listener at
    // all under readOnly, so the class never changed).
    const wasOpen = await box.evaluate((el) => el.classList.contains("cm-lp-details-open"));
    await bar.click();
    await sleep(350);
    const nowOpen = await box.evaluate((el) => el.classList.contains("cm-lp-details-open"));
    expect(nowOpen, `${mode}: the read-only surface toggled the details open state`).toBe(!wasOpen);
    if (nowOpen) {
      expect((await page.locator("[data-pane=preview] [data-testid=details-body]").first().boundingBox())!.height, `${mode}: body shows when opened`).toBeGreaterThan(8);
    }
  }
});

// #337 issue 2 (edit path): the raw source is reached via the hover ✎ edit button, not by the bar click.
test(":::details ✎ edit button reveals the raw source for editing", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "details");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(":::details[More info]\nthe hidden body\n:::\n\nbelow\n");
  await sleep(400);

  const edit = page.locator("[data-pane=preview] [data-testid=details-edit]");
  await edit.dispatchEvent("mousedown"); // hover-shown (opacity); mousedown is the wired trigger
  await sleep(250);
  const revealed = await page.locator("[data-pane=preview] .cm-content").innerText();
  expect(revealed).toContain(":::details[More info]");
  expect(revealed).toContain("the hidden body");
});

// #337 issue 1: an icon-less directive-label (details) must NOT paint the ::before box — with --cb-icon
// unset it degrades to a solid grey square on the revealed open fence. The label text stays.
test(":::details revealed open fence shows no grey ::before square", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "details");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(":::details[More info]\nthe hidden body\n:::\n\nbelow\n");
  await sleep(400);

  // Reveal raw via the ✎ so the open fence gets the cm-lp-details.cm-lp-directive-label class pair.
  await page.locator("[data-pane=preview] [data-testid=details-edit]").dispatchEvent("mousedown");
  await sleep(250);
  const label = page.locator("[data-pane=preview] .cm-lp-details.cm-lp-directive-label").first();
  await expect(label).toBeVisible();
  const beforeDisplay = await label.evaluate((el) => getComputedStyle(el, "::before").display);
  expect(beforeDisplay).toBe("none");
});
