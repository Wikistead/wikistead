import { test, expect, type Page } from "@playwright/test";
import { enterEdit, openScratch, sleep, API } from "../helpers";
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
// #425 / ADR-168 (migrated pin — the old "✎ reveals raw" behaviour is deliberately FLIPPED): the ✎
// opens the PANEL editUI (summary field + body textarea); `:::` never renders while editing. Edits
// round-trip through one replaceSource per change; Source mode is the raw path.
test("#425: :::details ✎ opens the panel editUI (no raw `:::`); summary+body round-trip", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "details");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(":::details[More info]\nthe hidden body\n:::\n\nbelow\n");
  await sleep(400);

  const edit = page.locator("[data-pane=preview] [data-testid=details-edit]");
  await edit.dispatchEvent("mousedown"); // hover-shown (opacity); mousedown is the wired trigger
  await sleep(300);
  await expect(page.getByTestId("details-editui")).toBeVisible({ timeout: 5000 });
  // The details editUI mounts a NESTED CodeMirror for the body, whose `.cm-content` also lives inside the
  // preview pane — so this selector became ambiguous (strict-mode violation) and the test had been red on
  // master, for a reason unrelated to what it checks. Read the OUTER surface, which is what "the DOM never
  // shows raw fences" is about; the nested editor is identified by its own testid.
  const inEdit = await page.locator("[data-pane=preview] .cm-content:not([data-testid])").innerText();
  expect(inEdit, "the DOM never shows raw fences while editing").not.toContain(":::details");
  // edit summary + body → commit (change events) → Escape exits to the rendered widget
  const summary = page.getByTestId("details-edit-summary");
  await summary.click();
  await summary.fill("New title");
  const body = page.getByTestId("details-edit-body");
  await body.click();
  await body.fill("fresh body");
  await page.keyboard.press("Escape");
  await sleep(400);
  await page.getByText("below", { exact: true }).click(); // caret OUT (an empty caret inside still reveals raw)
  await sleep(300);
  await expect(page.getByTestId("details-summary-bar")).toBeVisible({ timeout: 5000 });
  expect(await page.locator("[data-pane=preview] [data-testid=details-summary-bar]").innerText()).toContain("New title");
  // Source mode shows the round-tripped raw
  await page.getByTestId("displaymode-source").click();
  await sleep(300);
  const src = await page.locator("[data-pane=preview] .cm-content").innerText();
  expect(src).toContain(":::details[New title]");
  expect(src).toContain("fresh body");
});

// #425: empty-summary keeps the previous label; [ ] and newlines are stripped (fence-head safety).
test("#425: an empty summary keeps the old label; bracket chars are stripped", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "details-sanitize");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(":::details[Keep me]\nbody\n:::\n\nbelow\n");
  await sleep(400);
  await page.locator("[data-pane=preview] [data-testid=details-edit]").dispatchEvent("mousedown");
  await sleep(300);
  const summary = page.getByTestId("details-edit-summary");
  await summary.fill("");
  await page.getByTestId("details-edit-body").click(); // change fires on blur
  await sleep(200);
  await summary.fill("a[b]c");
  await page.getByTestId("details-edit-body").click();
  await sleep(200);
  await page.keyboard.press("Escape");
  await sleep(300);
  await page.getByTestId("displaymode-source").click();
  await sleep(300);
  const src = await page.locator("[data-pane=preview] .cm-content").innerText();
  expect(src).toContain(":::details[abc]"); // brackets stripped; the intermediate empty kept "Keep me"
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

  // #425: the ✎ now opens the panel — reveal raw via caret ENTRY instead (an empty caret inside the
  // block still reveals the raw source; only the explicit ✎/Ctrl+↵ path flipped to the panel).
  await page.getByText("below", { exact: true }).click();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await sleep(350);
  const label = page.locator("[data-pane=preview] .cm-lp-details.cm-lp-directive-label").first();
  await expect(label).toBeVisible();
  const beforeDisplay = await label.evaluate((el) => getComputedStyle(el, "::before").display);
  expect(beforeDisplay).toBe("none");
});
