import { test, expect, type Browser } from "@playwright/test";
import { openDemo, enterEdit, resetDoc, sleep } from "../helpers";

// Step I presence point #1 (critical): toggling vim reconfigures a CodeMirror
// Compartment IN PLACE — it must NOT remount the editor, drop the collab connection,
// or leak/lose a remote caret. Plus a functional check that the vim keymap takes
// effect (so the toggle isn't a no-op).
test("vim toggle keeps collab/presence and activates the keymap", async ({ browser }: { browser: Browser }) => {
  const A = await (await browser.newContext()).newPage();
  const B = await (await browser.newContext()).newPage();
  await openDemo(A); await openDemo(B);
  await enterEdit(A); await enterEdit(B);
  await resetDoc(A);
  await A.click("[data-pane=preview] .cm-content");
  await A.keyboard.type("hello");
  // Collab established: A's edit reaches B. (Caret COUNT is unreliable here — `demo`
  // is shared across the suite, so stale awareness clients linger as ghost carets;
  // the dedicated presence specs cover caret mapping. Here we assert what actually
  // proves the connection is alive: content sync.)
  await expect.poll(async () => B.evaluate(() => document.querySelector("[data-pane=preview] .cm-content")?.textContent ?? ""), { timeout: 5000 }).toContain("hello");

  // The toggle reads its state at a glance (role=switch, aria-checked).
  await expect(A.getByTestId("vim-toggle")).toHaveAttribute("aria-checked", "false");
  // Toggle vim ON — a Compartment reconfigure, not a remount.
  await A.getByTestId("vim-toggle").click();
  await sleep(600);
  await expect(A.getByTestId("vim-toggle")).toHaveAttribute("aria-checked", "true");
  // The editor was not remounted: still a single surface.
  expect(await A.locator("[data-pane=preview] .cm-content").count()).toBe(1);

  // vim keymap is live AND collab survived the reconfigure: in NORMAL mode '0' is
  // line-start and 'x' deletes the char under the cursor (NOT typed as text), and the
  // resulting edit must still sync to B. "hello" → "ello".
  await A.click("[data-pane=preview] .cm-content");
  await A.keyboard.press("Escape");
  await A.keyboard.press("0");
  await A.keyboard.press("x");
  const aText = await A.evaluate(() => document.querySelector("[data-pane=preview] .cm-content")?.textContent ?? "");
  expect(aText).toContain("ello");
  expect(aText).not.toContain("hello"); // a real vim delete, not an inserted "0x"
  // post-toggle edit reaches B → the Compartment reconfigure did not drop collab.
  await expect.poll(async () => B.evaluate(() => document.querySelector("[data-pane=preview] .cm-content")?.textContent ?? ""), { timeout: 5000 }).not.toContain("hello");
});
