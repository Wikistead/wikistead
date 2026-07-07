import { test, expect } from "@playwright/test";
import { enterEdit, createScratchPage, sleep } from "../helpers";

// #92 external presence: while A has a macro's modal (Excalidraw) open, A leaves the page live-preview
// surface, so peers would see A "nowhere". macro-modal.ts publishes "editing the macro at <anchor>" onto
// the page awareness; the peer draws a "N editing" badge at that macro. Real Chromium, two contexts.
//
// Regression root cause (fixed): the badge is anchored at the macro block's start = the start of its
// atomic block-replace range, so it MUST be a block widget — and CM forbids block decorations from a
// ViewPlugin ("Block decorations may not be specified via plugins"). Moving the badge to a StateField
// (macroPresenceField) makes it render. This spec is the anti-test for that.
test("#92: a peer sees a presence badge when another opens a macro's modal", async ({ browser }) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const A = await ctxA.newPage();
  const B = await ctxB.newPage();
  try {
    await A.goto("/p/demo");
    await A.waitForSelector("[data-pane=preview] .cm-content");
    const id = await createScratchPage(A, "presbadge");
    for (const p of [A, B]) {
      await p.goto(`/p/${id}`);
      await p.waitForSelector("[data-pane=preview] .cm-content");
    }
    await sleep(600);
    await enterEdit(A);
    await enterEdit(B);

    // A inserts an excalidraw fence (with text above so the block isn't at offset 0).
    await A.click("[data-pane=preview] .cm-content");
    for (const line of ["above text", "", "```excalidraw", "```", "", "below"]) {
      await A.keyboard.type(line);
      await A.keyboard.press("Enter");
    }
    await sleep(1000);
    // B synced the macro.
    await expect(B.locator("[data-pane=preview] [data-testid=macro-excalidraw]")).toBeVisible();

    // No badge before A opens the modal.
    await expect(B.locator("[data-pane=preview] [data-testid=macro-presence]")).toHaveCount(0);

    // A opens the Excalidraw modal (select → edit button).
    const macroA = A.locator("[data-pane=preview] [data-testid=macro-excalidraw]");
    await macroA.click();
    await A.getByTestId("macro-edit").click();
    await expect(A.getByTestId("macro-modal")).toBeVisible();

    // B shows the presence badge at the macro.
    const badgeB = B.locator("[data-pane=preview] [data-testid=macro-presence]");
    await expect(badgeB).toHaveCount(1, { timeout: 5000 });
    await expect(badgeB).toContainText("editing");

    // Closing the modal clears the badge for the peer.
    await A.getByTestId("macro-modal-cancel").click();
    await expect(A.getByTestId("macro-modal")).toHaveCount(0);
    await expect(badgeB).toHaveCount(0, { timeout: 5000 });

    // The presence overlay must NOT disturb yCollab: exactly one remote caret still syncs A→B.
    await A.click("[data-pane=preview] .cm-content");
    await A.keyboard.type("x");
    await sleep(600);
    expect(await B.locator("[data-pane=preview] .cm-ySelectionCaret").count()).toBe(1);
  } finally {
    await ctxA.close();
    await ctxB.close();
  }
});
