import { test, expect } from "@playwright/test";
import { openScratch, enterEdit, sleep } from "../helpers";

// ADR-056 / #164 (phase 1): the editor display mode is an editor-wide axis, orthogonal to vim.
// Live (default) = reveal syntax only under the caret; Source = syntax ALWAYS raw. The toggle is
// display-only (no doc change). Here: a :::note callout's `:::` fence is hidden in Live with the
// caret away, and always shown in Source.
test("display-mode toggle: Source reveals syntax always; Live hides it off-cursor", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "dispmode");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(":::note\nhello body\n:::\n\nplain tail\n");
  await sleep(300);
  // Caret to the LAST line (away from the callout) so Live hides the fence.
  await page.keyboard.press("Control+End");
  await sleep(200);

  const content = () => page.locator("[data-pane=preview] .cm-content").innerText();
  // Live (default): the `:::note` fence syntax is hidden (rendered as a callout box).
  expect(await content()).not.toContain(":::note");

  // Toggle to Source → syntax always raw.
  const toggle = page.getByTestId("displaymode-toggle");
  await expect(toggle).toBeVisible();
  await toggle.click();
  await sleep(250);
  await expect(toggle).toHaveAttribute("data-mode", "source");
  expect(await content()).toContain(":::note"); // raw fence shown even though the caret is elsewhere

  // Toggle back to Live → hidden again (display-only; the doc never changed).
  await toggle.click();
  await sleep(250);
  await expect(toggle).toHaveAttribute("data-mode", "live");
  expect(await content()).not.toContain(":::note");
});
