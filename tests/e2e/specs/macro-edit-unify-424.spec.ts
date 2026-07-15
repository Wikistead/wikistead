import { test, expect } from "@playwright/test";
import { openScratch, enterEdit, sleep } from "../helpers";

// #424: ONE edit-entry affordance across macros — every entry button (editUI, richEditUI, raw reveal,
// nested) wears the same face (pencil icon + visible "Ctrl+↵" key hint) and sits at the block's TOP-LEFT
// with the same offset in Live and WYSIWYG. Real Chromium (positions/opacity are computed).

const setMode = async (page: import("@playwright/test").Page, m: string) => {
  await page.getByTestId(`displaymode-${m}`).click();
  await sleep(250);
  await expect(page.getByTestId("displaymode-segment")).toHaveAttribute("data-mode", m);
};

// Button position relative to its macro block, rounded — the cross-mode comparison key.
async function relPos(btn: import("@playwright/test").Locator, block: import("@playwright/test").Locator) {
  const b = await btn.boundingBox();
  const w = await block.boundingBox();
  if (!b || !w) throw new Error("boundingBox unavailable");
  return { dx: Math.round(b.x - w.x), dy: Math.round(b.y - w.y) };
}

test("#424: mermaid (editUI-only fence) shows the unified icon+Ctrl+↵ button, not a bare pencil", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "unify-mermaid");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("```mermaid\ngraph TD; A-->B\n```\nbelow\n");
  await sleep(600);
  const macro = page.locator("[data-pane=preview] [data-testid=macro-mermaid]");
  await expect(macro).toBeVisible();
  await macro.hover();
  await sleep(300);
  const editBtn = page.getByTestId("macro-edit").first();
  // The face: icon + the visible key hint (previously mermaid had a bare pencil —asymmetry).
  await expect(editBtn.locator("svg")).toHaveCount(1);
  await expect(editBtn.locator(".cm-lp-macro-richui-key")).toHaveText("Ctrl+↵");
});

test("#424: the edit button sits at the SAME top-left offset in Live and WYSIWYG", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "unify-pos");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("intro paragraph\n\n```mermaid\ngraph TD; A-->B\n```\ntail\n");
  await sleep(600);

  const macro = page.locator("[data-pane=preview] [data-testid=macro-mermaid]");
  await setMode(page, "live");
  await page.keyboard.press("Control+End"); // caret away → the macro renders as a widget
  await macro.hover();
  await sleep(300);
  const live = await relPos(page.getByTestId("macro-edit").first(), macro);

  await setMode(page, "wysiwyg");
  await macro.hover();
  await sleep(300);
  const wys = await relPos(page.getByTestId("macro-edit").first(), macro);

  // Same offset in both modes (the pre-#424 drift was mode-dependent anchoring), and top-LEFT: the
  // button starts at the block's left edge and floats above its top edge.
  expect(Math.abs(live.dx - wys.dx), `left offset differs live=${live.dx} wys=${wys.dx}`).toBeLessThanOrEqual(2);
  expect(Math.abs(live.dy - wys.dy), `top offset differs live=${live.dy} wys=${wys.dy}`).toBeLessThanOrEqual(2);
  expect(live.dx, "button should hug the block's left edge").toBeLessThanOrEqual(4);
  expect(live.dy, "button should float above the block top").toBeLessThan(0);
});

test("#424: a nested macro's edit button is unified too (Ctrl+↵ face, slot top-left)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "unify-nested");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(":::columns\n::: column\n```mermaid\ngraph TD; A-->B\n```\n:::\n::: column\nright\n:::\n:::\nafter\n");
  await sleep(800);
  await setMode(page, "wysiwyg"); // WYSIWYG draws the hover pencil on every editable nested slot
  const columns = page.locator("[data-pane=preview] [data-testid=macro-columns]").first();
  await expect(columns).toBeVisible();
  const nestedBtn = columns.getByTestId("nested-macro-edit").first();
  await expect(nestedBtn).toHaveCount(1);
  // Unified face on the nested variant as well (previously a bare pencil).
  await expect(nestedBtn.locator(".cm-lp-macro-richui-key")).toHaveText("Ctrl+↵");
  // Anchored to its slot's top-left (the old -0.9em/-0.4em wander and the tabpanel 2px special case are gone).
  const slot = columns.locator("[data-mac-pos]").first();
  const rel = await relPos(nestedBtn, slot);
  expect(rel.dx, "nested button hugs the slot's left edge").toBeLessThanOrEqual(4);
  expect(rel.dy, "nested button floats above the slot top").toBeLessThan(0);
});
