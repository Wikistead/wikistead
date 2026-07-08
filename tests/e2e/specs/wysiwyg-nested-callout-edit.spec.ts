import { test, expect } from "@playwright/test";
import { enterEdit, openScratch, sleep } from "../helpers";

// #174 comment 1003 / ADR-100 (WYSIWYG nested parity): a callout NESTED inside a columns/tabs container had
// NO edit entry in WYSIWYG — the top-level panel got a hover ✎ (comment 894) but the nested equivalent was
// missing (nested edit was click-to-select only, which relies on a raw-reveal path WYSIWYG lacks), leaving
// a nested callout uneditable in WYSIWYG. The fix gives every editable nested slot the same hover-gated ✎
// (→ its editUI via enterNestedMacroAt). This asserts the nested case; wysiwyg-callout-edit.spec covers the
// top-level case (must stay green). Real Chromium.
test("#174: WYSIWYG nested callout (inside columns) has a hover ✎ that opens its editUI", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await openScratch(page, "wys-nested-callout");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(
    "::::columns\n:::column\n:::warning\nnested watch\n:::\n:::\n:::column\nplain\n:::\n::::\n\nbelow\n",
  );
  await sleep(500);
  await page.getByTestId("displaymode-wysiwyg").click();
  await sleep(500);

  // The columns container renders, WITH the nested callout panel inside it (not raw).
  const columns = page.locator("[data-pane=preview] [data-testid=macro-columns]").first();
  await expect(columns).toBeVisible();
  const nestedCallout = columns.locator(".cm-lp-callout-panel").first();
  await expect(nestedCallout).toBeVisible();
  const raw = await page.locator("[data-pane=preview] .cm-content").innerText();
  expect(raw).not.toContain(":::warning"); // WYSIWYG hides syntax → no reveal path to the editUI

  // BEFORE the fix: hovering the nested callout showed no edit entry at all (callout-panel-edit 0 AND
  // nested-macro-edit 0). Now hovering it reveals the nested ✎.
  await nestedCallout.hover();
  const edit = columns.getByTestId("nested-macro-edit").first();
  await expect(edit, "the nested callout has a hover edit entry in WYSIWYG").toBeVisible();

  // Clicking it mounts the callout editUI in place (type/header/content) — the nested edit island.
  await edit.click();
  await sleep(300);
  await expect(page.getByTestId("callout-edit-type")).toBeVisible();

  expect(errors, errors.join(" | ")).toHaveLength(0);
});
