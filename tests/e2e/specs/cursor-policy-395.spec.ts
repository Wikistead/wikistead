import { test, expect } from "@playwright/test";
import { openScratch, enterEdit, sleep } from "../helpers";

// #395 / ADR-156: the atom/typed-body cursor policy, pinned in real Chromium.
//  - `:::children` (the straggler) is now an ATOM: an empty caret SELECTS it (ring), never reveals
//    its raw fences; Ctrl+Enter (explicit entry) reveals raw; dd removes the whole block.
//  - Affordance rule 2: an atom body computes `cursor: default` (never `text`); the #273 download
//    card keeps its whole-surface `pointer`; a typed-body macro's revealed source keeps the I-beam.

test("#395: :::children is an atom — ring select, no caret reveal, explicit entry reveals raw", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "children-atom-395");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("intro\n\n:::children\n:::\n\ntail\n");
  await sleep(700);
  await page.getByText("tail", { exact: true }).click();
  await sleep(300);
  // the empty children block on the EDIT surface keeps its dim placeholder (selectable target)
  const atom = page.locator("[data-pane=preview] [data-testid=macro-children-empty], [data-pane=preview] [data-testid=macro-children-placeholder]").first();
  await expect(atom).toHaveCount(1);
  // click the atom → SELECT (ring), raw does NOT reveal
  await atom.click();
  await sleep(400);
  const revealed = await page.evaluate(() =>
    [...document.querySelectorAll("[data-pane=preview] .cm-line")].some((l) => (l.textContent || "").includes(":::children")));
  expect(revealed, "caret-in must NOT reveal the raw fences").toBe(false);
  await expect(page.locator("[data-pane=preview] .cm-lp-atom-sel"), "the atom ring shows").toHaveCount(1);
  // explicit entry (Ctrl+Enter) reveals the raw source
  await page.keyboard.press("Control+Enter");
  await sleep(400);
  const rawNow = await page.evaluate(() =>
    [...document.querySelectorAll("[data-pane=preview] .cm-line")].some((l) => (l.textContent || "").includes(":::children")));
  expect(rawNow, "explicit entry reveals raw").toBe(true);
});

test("#395: vim dd on the selected :::children atom removes the whole block", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "children-dd-395");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("intro\n\n:::children\n:::\n\ntail\n");
  await sleep(700);
  await page.getByText("tail", { exact: true }).click();
  await sleep(200);
  await page.getByTestId("vim-toggle").click();
  await sleep(300);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.press("Escape");
  // caret to the atom (line 3 area) via gg + j j
  await page.keyboard.type("gg");
  await page.keyboard.type("jj");
  await sleep(300);
  await page.keyboard.type("dd");
  await sleep(400);
  const src = await page.locator("[data-pane=preview] .cm-content").first().innerText();
  expect(src, "the whole block is gone (no orphan fence)").not.toContain(":::");
  expect(src).toContain("intro");
  expect(src).toContain("tail");
});

test("#395 rule 2: atom bodies compute cursor default; the DL card keeps pointer; typed raw keeps text", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "cursor-sweep-395");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("intro\n\n:::embed-page\nsome-page-id\n:::\n\n::::columns\n:::column\nL\n:::\n:::column\nR\n:::\n::::\n\n:::warning[w]\ntyped body\n:::\n\ntail\n");
  await sleep(900);
  await page.getByText("tail", { exact: true }).click();
  await sleep(400);
  const cursors = await page.evaluate(() => {
    const pick = (sel: string) => {
      const el = document.querySelector(`[data-pane=preview] ${sel}`);
      return el ? getComputedStyle(el).cursor : null;
    };
    return {
      embed: pick("[data-testid=macro-embed-page]"),
      columns: pick(".cm-lp-columns"),
      calloutPanel: pick(".cm-lp-callout-panel"),
    };
  });
  expect(cursors.embed, "embed atom body = default").toBe("default");
  expect(cursors.columns, "columns container = default").toBe("default");
  expect(cursors.embed).not.toBe("text");
  expect(cursors.columns).not.toBe("text");
  // typed-body: reveal the callout and check the raw line keeps the text I-beam
  await page.getByText("typed body").click();
  await sleep(400);
  const rawCursor = await page.evaluate(() => {
    const line = [...document.querySelectorAll("[data-pane=preview] .cm-line")].find((l) => (l.textContent || "").includes("typed body"));
    return line ? getComputedStyle(line).cursor : null;
  });
  // contenteditable lines compute "auto" (the UA renders the I-beam); the pin is that typed raw is
  // NOT swept to "default" like an atom body.
  expect(rawCursor, "typed-body raw keeps the text affordance").not.toBe("default");
});

// #395 the policy hint must (A) live on a surface EXISTING users can reach — Settings →
// Account → Editor, not just the first-run onboarding done screen — and (B) describe the
// IMPLEMENTATION: ring + Ctrl+Enter belong to reference cards (embed/transclude/children) only;
// layouts and callouts are click-into-edit, never claimed as ring atoms.
test("#395 the atom-policy hint is reachable in account settings and matches the implementation", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await page.goto("/p/demo");
  await page.waitForSelector("[data-pane=preview] .cm-content");
  await page.goto("/settings/account/editor");
  const card = page.getByTestId("account-atom-policy");
  await expect(card, "the policy card renders for every member (no firstRun gate)").toBeVisible({ timeout: 8000 });
  const text = (await card.innerText()).replace(/\s+/g, " ");
  expect(text, "names the entry key").toContain("Ctrl+Enter");
  expect(text, "ring is scoped to REFERENCE cards").toMatch(/reference cards/i);
  expect(text, "layouts/callouts are click-into-edit, not ring atoms").toMatch(/layouts and callouts open for editing/i);
  expect(text, "must not claim layouts select as a unit").not.toMatch(/\(embeds, images, layouts/i);
});

// #395 ①: a ring-selected atom must SHOW its Ctrl+↵ entry pill — the ring alone gave no hint that
// Ctrl+Enter acts on the atom (the raw pill only reveals on raw-zone hover, which a rendered atom never
// has). The pill inherits the ✎ hover/atom-sel gating and routes through the exact Ctrl+Enter command.
test("#395 selecting an atom (ring) reveals the Ctrl+Enter entry pill", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "atom-entry-pill-395");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(":::children\n:::\n\ntail\n");
  await page.keyboard.press("Control+End");
  await sleep(600);
  // #450 slice 5c: an empty `:::children` is the HOST's slot (`-slot`, with `-empty` inside it on the
  // edit surface) rather than the macro's own placeholder. The test is about clicking the ATOM and
  // getting the ring, so it names every shape the atom can have instead of one that used to be there.
  await page.locator([
    "[data-testid=macro-children]",
    "[data-testid=macro-children-slot]",
    "[data-testid=macro-children-empty]",
    "[data-testid=macro-children-placeholder]",
  ].join(", ")).first().click();
  await sleep(400);
  await expect(page.locator(".cm-lp-atom-sel")).toHaveCount(1); // the ring is on
  const pill = page.getByTestId("macro-entry-pill").first();
  await expect(pill).toBeAttached({ timeout: 5000 });
  const opacity = await pill.evaluate((el) => parseFloat(getComputedStyle(el).opacity));
  expect(opacity, "entry pill visible on the selected atom").toBeGreaterThanOrEqual(0.8);
});

// #395 ②: a PLAIN click on a rendered callout must NOT auto-launch the rich edit form — click /
// caret-in edits in place (Live reveals raw; WYSIWYG keeps the atom); the type/header form opens only
// via the explicit ✎ / Ctrl+Enter. (Pinned on both modes; the ✎ path is separately pinned by the
// wysiwyg-callout suites.)
test("#395 clicking a rendered callout never auto-opens the edit form (Live + WYSIWYG)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "callout-click-noform-395");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(":::note[Hey]\ncallout body\n:::\n\ntail\n");
  await page.keyboard.press("Control+End");
  await sleep(600);
  // Live: click the panel body → raw reveals, NO form
  await page.getByTestId("callout-panel").first().click({ position: { x: 60, y: 40 } });
  await sleep(500);
  await expect(page.getByTestId("callout-edit-type")).toHaveCount(0);
  expect(await page.locator("[data-pane=preview] .cm-content").innerText()).toContain(":::note"); // in-place raw edit
  // WYSIWYG: click the panel body → atom stays, NO form
  await page.getByText("tail", { exact: true }).click();
  await page.locator("[role=radiogroup] [role=radio]").nth(3).click();
  await sleep(600);
  await page.getByTestId("callout-panel").first().click({ position: { x: 60, y: 40 } });
  await sleep(500);
  await expect(page.getByTestId("callout-edit-type")).toHaveCount(0);
});
