import { test, expect, type Page } from "@playwright/test";
import { openScratch, enterEdit } from "../helpers";

// The old full-width top bar is gone; its controls float in role-based groups (status by
// the title, actions bottom-right, vim bottom-left). Behaviour is unchanged (covered by
// the other specs) — here we assert the relocation + the title wrap/clamp.
const lineClamp = (p: Page) =>
  p.getByTestId("page-title").evaluate((el) => getComputedStyle(el).webkitLineClamp);

test("floating controls + title clamp (view) / full (edit)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "a very long page title that should wrap to two lines and then ellipsise rather than overflow forever");

  // VIEW: status group (with the draft badge) sits by the title; edit action floats.
  await expect(page.getByTestId("page-status")).toBeVisible();
  await expect(page.getByTestId("draft-badge")).toBeVisible();
  await expect(page.getByTestId("edit-toggle")).toBeVisible();
  expect(await lineClamp(page)).toBe("2"); // long title clamps to 2 lines in view

  // EDIT: vim floats bottom-left; publish/done float bottom-right; title shows in full.
  await enterEdit(page);
  await expect(page.getByTestId("vim-toggle")).toBeVisible();
  await expect(page.getByTestId("publish-page")).toBeVisible();
  await expect(page.getByTestId("view-toggle")).toBeVisible();
  expect(await lineClamp(page)).toBe("none"); // full title while editing it
});
