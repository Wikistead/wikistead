import { test, expect, type Browser } from "@playwright/test";
import { enterEdit, createScratchPage, sleep } from "../helpers";

// #454: presence must CLEAR when a peer leaves EDIT mode, not only on full disconnect. The
// edit→view transition keeps the collab connection (sync stays live), but yCollab's plugin never
// nulls its last `cursor` on destroy and the macroEdit anchor had no exit path — so peers kept
// seeing a caret/frame for someone who had stopped editing. The fix clears the presence fields in
// the edit-surface teardown (connection untouched). Two real clients over real collab.
test("#454: leaving edit mode clears the peer-visible caret; sync stays connected", async ({ browser }: { browser: Browser }) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const A = await ctxA.newPage();
  const B = await ctxB.newPage(); // observer
  try {
    await A.goto("/p/demo");
    await A.waitForSelector("[data-pane=preview] .cm-content");
    const id = await createScratchPage(A, "pclr454");
    for (const p of [A, B]) {
      await p.goto(`/p/${id}`);
      await p.waitForSelector("[data-pane=preview] .cm-content");
    }
    await sleep(600);
    await enterEdit(A);
    await enterEdit(B);

    // A parks a caret → B sees exactly one remote caret.
    await A.click("[data-pane=preview] .cm-content");
    await A.keyboard.type("presence 454");
    await sleep(900);
    await expect(B.locator("[data-pane=preview] .cm-ySelectionCaret")).toHaveCount(1, { timeout: 8000 });

    // A leaves EDIT mode (publish exits back to the rendered view, the reported flow).
    await A.getByTestId("publish-page").click();
    await expect(A.getByTestId("edit-toggle")).toBeVisible({ timeout: 8000 });

    // B: A's caret disappears even though A's tab (and its collab connection) is still open.
    await expect(B.locator("[data-pane=preview] .cm-ySelectionCaret")).toHaveCount(0, { timeout: 8000 });

    // The connection stayed live: A re-enters edit, types — the text SYNCS to B (no reconnect race)
    // and the caret comes back.
    await enterEdit(A);
    await A.click("[data-pane=preview] .cm-content");
    await A.keyboard.press("End");
    await A.keyboard.type(" back");
    await sleep(1200);
    await expect(B.locator("[data-pane=preview] .cm-content")).toContainText("presence 454 back", { timeout: 8000 });
    await expect(B.locator("[data-pane=preview] .cm-ySelectionCaret")).toHaveCount(1, { timeout: 8000 });
  } finally {
    await ctxA.close();
    await ctxB.close();
  }
});
