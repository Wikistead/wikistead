import { test, expect, type Browser } from "@playwright/test";
import { enterEdit, createScratchPage, sleep } from "../helpers";

// #8 the presence showcase: a remote collaborator's caret carries an avatar + name
// flag. This is an ADDITIVE overlay on yCollab — foundation.spec (ghost cursor) and
// editor.spec (cross-surface presence) prove the invariants still hold; this asserts
// the flag itself renders for a remote caret, with the right identity.
//
// Uses a UNIQUE page (not the shared demo doc) and closes its contexts so this test's
// transient presence carets cannot linger as ghosts into other demo-based specs.
test("a remote caret shows an avatar + name flag", async ({ browser }: { browser: Browser }) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const A = await ctxA.newPage();
  const B = await ctxB.newPage(); // observer
  try {
    // a REAL throwaway page (unique doc → no shared-demo ghost; non-existent pages are
    // no longer editable phantoms, so the test edits a real page in a space)
    await A.goto("/p/demo");
    await A.waitForSelector("[data-pane=preview] .cm-content");
    const id = await createScratchPage(A, "curav");
    for (const p of [A, B]) {
      await p.goto(`/p/${id}`);
      await p.waitForSelector("[data-pane=preview] .cm-content");
    }
    await sleep(600);
    await enterEdit(A);
    await enterEdit(B);

    // A parks a caret; B should render A's flag at it.
    await A.click("[data-pane=preview] .cm-content");
    await A.keyboard.type("hello from A");
    await sleep(900);

    const name = B.locator("[data-pane=preview] .cm-remoteCursorName").first();
    const avatar = B.locator("[data-pane=preview] .cm-remoteCursorAvatar").first();
    // dev-token identity → name "dev-user", initials "DE", no picture (initials, no img).
    // The name/initials live in CSS ::after/::before (content: attr(...)), NOT as text
    // nodes — so a presence flag never pollutes document-text/offset logic. Assert the
    // backing data-* attributes the pseudo-elements render from.
    await expect(name).toHaveAttribute("data-name", "dev-user");
    await expect(avatar).toHaveAttribute("data-initials", "DE");
    expect(await avatar.locator("img").count()).toBe(0);

    // The overlay does NOT add a second yCollab caret — foundation's count invariant
    // (exactly one .cm-ySelectionCaret) must still hold with the flag present.
    expect(await B.locator("[data-pane=preview] .cm-ySelectionCaret").count()).toBe(1);
  } finally {
    await ctxA.close();
    await ctxB.close();
  }
});
