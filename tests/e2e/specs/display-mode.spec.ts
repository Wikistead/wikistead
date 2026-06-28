import { test, expect } from "@playwright/test";
import { openScratch, enterEdit, sleep } from "../helpers";

// ADR-056 / #164: the editor display mode is an editor-wide axis, orthogonal to vim, cycled by the
// toolbar pill (live → source → reading → live). Live = reveal syntax under the caret only;
// Source = syntax always raw; Reading = clean render, read-only (no grips, no checkbox toggles).
test("display-mode cycle: live → source → reading → live (display-only)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "dispmode");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(":::note\nhello body\n:::\n\nplain tail\n");
  await sleep(300);
  await page.keyboard.press("Control+End"); // caret away from the callout so Live hides the fence
  await sleep(200);

  const content = () => page.locator("[data-pane=preview] .cm-content").innerText();
  const toggle = page.getByTestId("displaymode-toggle");
  const grips = page.locator("[data-pane=preview] [data-testid=block-grip]");

  // Normalize to Live first (the member's persisted startup pref may be source/reading from
  // another spec sharing the e2e DB; the cycle is live → source → reading → live).
  for (let i = 0; i < 3 && (await toggle.getAttribute("data-mode")) !== "live"; i++) { await toggle.click(); await sleep(150); }

  // Live: fence hidden; the surface is editable (grips present).
  await expect(toggle).toHaveAttribute("data-mode", "live");
  expect(await content()).not.toContain(":::note");
  expect(await grips.count()).toBeGreaterThan(0);

  // → Source: syntax always raw.
  await toggle.click(); await sleep(250);
  await expect(toggle).toHaveAttribute("data-mode", "source");
  expect(await content()).toContain(":::note");

  // → Reading: clean render (no syntax), read-only (contenteditable=false, no grips).
  await toggle.click(); await sleep(250);
  await expect(toggle).toHaveAttribute("data-mode", "reading");
  expect(await content()).not.toContain(":::note");
  expect(await page.locator("[data-pane=preview] .cm-content").getAttribute("contenteditable")).toBe("false");
  expect(await grips.count()).toBe(0); // no drag affordance on a clean reading view

  // → back to Live (display-only: the doc never changed — fence hidden again, editable again).
  await toggle.click(); await sleep(250);
  await expect(toggle).toHaveAttribute("data-mode", "live");
  expect(await content()).not.toContain(":::note");
  expect(await page.locator("[data-pane=preview] .cm-content").getAttribute("contenteditable")).toBe("true");
});
