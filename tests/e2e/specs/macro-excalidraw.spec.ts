import { test, expect } from "@playwright/test";
import { enterEdit, openScratch, sleep } from "../helpers";

// M2 (ADR-022 Part 3): ```excalidraw is a fence macro whose mouse editor is a MODAL.
// liveRender previews via Excalidraw's non-React exportToSvg (no React in CM, ADR-013);
// the edit button opens a plain-DOM modal that mounts the real <Excalidraw> React
// component (separate tree) — this also exercises Excalidraw under React 19. Save writes
// the scene back to the fence range (collab (a)); the ```excalidraw source round-trips.
test("```excalidraw: modal mounts Excalidraw, save writes back, source round-trips", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "excalidraw");
  await enterEdit(page);

  await page.click("[data-pane=preview] .cm-content");
  for (const line of ["```excalidraw", "```", "", "below"]) {
    await page.keyboard.type(line);
    await page.keyboard.press("Enter");
  }
  await sleep(400);

  // liveRender placeholder (empty scene) renders. (The common empty-macro placeholder for
  // a CLEAN empty fence is covered by macro-fixes' slash-insert test.)
  const macro = page.locator("[data-pane=preview] [data-testid=macro-excalidraw]");
  await expect(macro).toBeVisible();

  // Clicking the macro opens the modal (mode-based, Part 11) — mounts Excalidraw (React 19).
  await macro.click();
  await expect(page.getByTestId("macro-modal")).toBeVisible();
  await expect(page.locator(".wks-macro-modal .excalidraw")).toBeVisible({ timeout: 20000 });

  // Save → write back + close.
  await page.getByTestId("macro-modal-save").click();
  await expect(page.getByTestId("macro-modal")).toHaveCount(0);
  await sleep(200);

  // Round-trip: the ```excalidraw fence survives — it still renders as the macro after
  // the edit cycle (the canonical source was preserved, written back as the fence).
  await expect(page.locator("[data-pane=preview] [data-testid=macro-excalidraw]")).toBeVisible();
});
