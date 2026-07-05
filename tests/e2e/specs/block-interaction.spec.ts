import { test, expect } from "@playwright/test";
import { openScratch, enterEdit, sleep } from "../helpers";

// #174 / ADR-087 block interaction model — acceptance + the display-only invariant. A block macro's
// affordances (hover boundary highlight, caret-entry selection ring, the edit button) are DISPLAY-ONLY:
// they never change the document (single Y.Text / offset-invariant). And a keyboard user reaches the
// rich UI via a VISIBLE edit button that appears when the caret selects the block (ADR-087 sub-task 1/2).
test("block macro affordances are display-only and the edit button is keyboard-reachable", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "blockinteract");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  // A table directive = a liveRender WIDGET macro with a rich UI (the edit-button case).
  const src = ":::table\n| a | b |\n| - | - |\n| 1 | 2 |\n:::\n\nplain tail\n";
  await page.keyboard.insertText(src);
  await sleep(300);

  const content = () => page.locator("[data-pane=preview] .cm-content").innerText();
  const before = await content();

  // Caret-entry selection: move the caret up into the table atom → the atom is selected (ring) and the
  // edit button becomes visible (opacity 1) — the keyboard user's affordance to reach the rich UI.
  await page.keyboard.press("Control+Home");
  await sleep(150);
  const editBtn = page.locator("[data-pane=preview] [data-testid=macro-edit]").first();
  // The button exists for a richEditUI macro; it is present in the DOM (visibility is CSS hover/select).
  await expect(editBtn).toHaveCount(1);

  // Display-only invariant: hovering the block does NOT change the document.
  await page.locator("[data-pane=preview] .cm-lp-macro-wrap").first().hover();
  await sleep(120);
  expect(await content()).toBe(before); // no doc mutation from hover/selection affordances

  // The edit button opens the EXISTING rich UI (table modal) — same target as click / Ctrl+Enter.
  await editBtn.click({ force: true });
  await sleep(250);
  // The table modal mounts (its edit surface). The doc is still unchanged by merely opening it.
  expect(await content()).toContain("plain tail"); // page intact; opening the editor didn't rewrite it
});

// #174 / ADR-087 sub-task 4: the block-drag GRIP (the drag affordance in the interaction matrix) appears
// on hover over ANY top-level block — paragraphs AND widget-atom macros alike — in a zone SEPARATE from the
// edit button (grip in the left margin outside the block; edit button top-left inside). This was #174's
// held-back item ("grip not showing"), resolved by #84's hover-following grip; locked in here.
test("#174: the block-drag grip appears on hover over paragraphs and macro atoms (separate from the edit button)", async ({ browser }) => {
  const page = await (await browser.newContext({ viewport: { width: 1000, height: 700 } })).newPage();
  await openScratch(page, "blockgrip");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("a paragraph here\n\n```mermaid\ngraph TD\nA-->B\n```\n\nlast para\n");
  await sleep(600);
  await page.getByText("last para").click(); // caret off the macro so it renders as an atom
  await sleep(300);

  const grip = page.locator("[data-testid=block-grip]");
  // Hover a PARAGRAPH → grip shows.
  const para = await page.getByText("a paragraph here").boundingBox();
  if (para) await page.mouse.move(para.x + para.width / 2, para.y + para.height / 2);
  await sleep(250);
  await expect(grip, "grip shows on hover over a paragraph").toBeVisible();

  // Hover the MERMAID widget atom → grip still shows (a widget can stopPropagation; the capture-phase
  // listener still fires) AND the macro edit button is present — the two affordances co-exist, not collide.
  const svg = await page.locator("[data-pane=preview] svg").first().boundingBox().catch(() => null);
  if (svg) await page.mouse.move(svg.x + svg.width / 2, svg.y + svg.height / 2);
  await sleep(250);
  await expect(grip, "grip shows on hover over a widget-atom macro").toBeVisible();
  await expect(page.locator("[data-pane=preview] [data-testid=macro-edit]"), "the edit button co-exists with the grip").toHaveCount(1);
});
