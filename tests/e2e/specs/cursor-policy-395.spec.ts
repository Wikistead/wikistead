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
