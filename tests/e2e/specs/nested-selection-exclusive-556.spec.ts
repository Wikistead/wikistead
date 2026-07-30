import { test, expect, type Page } from "@playwright/test";
import { enterEdit, openScratch, sleep } from "../helpers";

// #556 (device find while checking #528): two defects with one root — the outer container's atom
// selection and the slot island's own focus were independent, so
//   (1) selecting the container and then clicking a nested macro left BOTH lit (two rings, two pills);
//   (2) the island always mounted with its caret at 0, so whichever nested macro was clicked, the FIRST
//       block in the slot took the selection (measured: clicking the lower of two stacked macros lit the
//       upper one).
// The fix: slot-edit counts as "focus inside" for the container (context highlight, no atom ring, no
// container pills — the #215 two-level convention), and the opening click's [data-mac-pos] target rides
// into the mount so the island's caret lands ON the clicked block. Inside the island each macro keeps its
// TOP-LEVEL behaviour (#278 A1) — for mermaid that is the #243 caret-in reveal, so "the clicked
// block responds" shows as its source revealing while its sibling stays a rendered figure.
// Real browser: rings, islands and carets are layout; happy-dom has none.

const FIXTURE = [
  "::::columns",
  ":::column",
  "```mermaid",
  "graph TD; A-->B;",
  "```",
  "",
  "```mermaid",
  "graph TD; C-->D;",
  "```",
  ":::",
  ":::column",
  "right column text",
  ":::",
  "::::",
  "",
  "tail text below the container",
  "",
].join("\n");

async function author(page: Page): Promise<void> {
  await openScratch(page, `nsel556-${Date.now().toString(36)}`);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.evaluate((text) => {
    const el = document.querySelector("[data-pane=preview] .cm-content") as { cmView?: { view?: unknown }; cmTile?: { view?: unknown } } | null;
    const view = (el?.cmView?.view ?? el?.cmTile?.view) as { state: { doc: { length: number } }; dispatch(t: unknown): void } | undefined;
    if (!view) throw new Error("no editor view to write the fixture into");
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
  }, FIXTURE);
  await sleep(2000); // mermaid draws async
}

const islandHead = (page: Page) =>
  page.evaluate(() => {
    type CmContent = Element & {
      cmView?: { view?: { state: { selection: { main: { head: number } }; doc: { toString(): string } } } };
      cmTile?: { view?: { state: { selection: { main: { head: number } }; doc: { toString(): string } } } };
    };
    const ic = document.querySelector(".cm-lp-slot-edit-island .cm-content") as CmContent | null;
    const v = ic?.cmView?.view ?? ic?.cmTile?.view;
    return v ? { head: v.state.selection.main.head, doc: v.state.doc.toString() } : null;
  });

async function clickSlot(page: Page, nth: number): Promise<void> {
  const slot = page.locator("[data-pane=preview] [data-mac-pos]").nth(nth);
  const box = (await slot.boundingBox())!;
  await page.mouse.click(box.x + 30, box.y + 30);
  await sleep(500);
}

async function runScenario(page: Page): Promise<void> {
  const container = page.locator("[data-pane=preview] .cm-lp-macro-wrap", { has: page.locator(".cm-lp-columns") }).first();

  // outer select first: the container's own atom ring shows
  const cbox = (await container.boundingBox())!;
  await page.mouse.click(cbox.x + cbox.width - 4, cbox.y + 4);
  await sleep(300);
  await expect(container, "outer click selects the container").toHaveClass(/cm-lp-atom-sel/);

  // (1) then click the TOP nested macro — the selection MOVES (exclusive), it does not accumulate
  await clickSlot(page, 0);
  await expect(page.getByTestId("slot-edit-island"), "the slot island opened").toBeVisible();
  await expect(container, "the container's atom ring yields while the focus is inside (RED: it stayed)").not.toHaveClass(/cm-lp-atom-sel/);
  await expect(container, "…dropping to the context highlight").toHaveClass(/cm-lp-nested-host/);
  expect(await page.locator("[data-pane=preview] .cm-lp-atom-sel").count(), "at most one selected block anywhere").toBeLessThanOrEqual(1);
  // the clicked (top) block is the island's target: its caret sits in the FIRST fence
  const topState = (await islandHead(page))!;
  expect(topState, "the island editor is live").not.toBeNull();
  expect(topState.head, "the island caret sits on the first (clicked) block").toBeLessThan(topState.doc.indexOf("C-->D"));

  // Esc backs out: the island closes and the container is the selected atom again (non-regression)
  await page.keyboard.press("Escape");
  await sleep(500);
  await expect(page.getByTestId("slot-edit-island")).toHaveCount(0);
  await expect(container, "Esc returns the selection to the container").toHaveClass(/cm-lp-atom-sel/);

  // (2) click the BOTTOM of the two stacked macros — the CLICKED one is the target
  await clickSlot(page, 1);
  await expect(page.getByTestId("slot-edit-island")).toBeVisible();
  const bottomState = (await islandHead(page))!;
  const secondFence = bottomState.doc.indexOf("```mermaid", bottomState.doc.indexOf("A-->B"));
  expect(bottomState.head, "the island caret sits on the SECOND (clicked) block (RED: it sat at 0, the first)").toBeGreaterThanOrEqual(secondFence);
  // …and visibly: the clicked block responds (its top-level caret-in reveal), the sibling stays rendered
  await expect(page.locator(".cm-lp-slot-edit-island .cm-lp-mermaid-fig"), "the UNclicked sibling keeps its figure").toHaveCount(1);
  expect(await page.locator(".cm-lp-slot-edit-island .cm-content").innerText(), "the clicked block's source revealed").toContain("C-->D");

  // clicking outside the container closes the island (non-regression of the commit-on-outside path)
  await page.getByText("tail text below the container").click();
  await sleep(500);
  await expect(page.getByTestId("slot-edit-island")).toHaveCount(0);
}

test("#556: nested-macro selection is exclusive and follows the click (non-vim)", async ({ browser }) => {
  test.setTimeout(120_000);
  const page = await (await browser.newContext()).newPage();
  await author(page);
  await runScenario(page);
});

test("#556: same exclusivity and click-targeting with vim on", async ({ browser }) => {
  test.setTimeout(120_000);
  const page = await (await browser.newContext()).newPage();
  await author(page);
  await page.getByTestId("vim-toggle").click();
  await sleep(300);
  await runScenario(page);
});
