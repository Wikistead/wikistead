import { test, expect } from "@playwright/test";
import { enterEdit, openScratch, sleep } from "../helpers";

// M1 slice 1 (ADR-022): the macro registry pipeline on the code-fence path (no parser).
// A ```mermaid block registers -> liveRender (an SVG diagram) -> fold (collapse to a
// summary line) -> Markdown round-trip (the source survives, offset-invariant).
//
// REAL throwaway page (unique id) so the transient presence caret can't ghost into
// other demo-based specs.
test("```mermaid macro: renders, folds/expands, round-trips raw source", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "macros");
  await enterEdit(page);

  await page.click("[data-pane=preview] .cm-content");
  // A mermaid fence, then a line below so the caret ends off the block (→ it renders,
  // not revealed).
  for (const line of ["```mermaid", "graph TD; A-->B;", "```", "", "below the diagram"]) {
    await page.keyboard.type(line);
    await page.keyboard.press("Enter");
  }
  await sleep(400);

  // liveRender: the macro widget mounts and mermaid (lazy-loaded) draws an <svg>.
  const macro = page.locator("[data-pane=preview] [data-testid=macro-mermaid]");
  await expect(macro).toBeVisible();
  await expect(macro.locator("svg")).toBeVisible({ timeout: 15000 }); // first mermaid load

  // Fold: the corner button collapses the block to the "▶ Mermaid diagram" summary.
  await macro.hover();
  await page.locator("[data-pane=preview] [data-testid=macro-fold]").click();
  await sleep(200);
  const folded = page.locator("[data-pane=preview] [data-testid=macro-folded]");
  await expect(folded).toBeVisible();
  await expect(folded).toContainText("Mermaid diagram");
  expect(await page.locator("[data-pane=preview] [data-testid=macro-mermaid]").count()).toBe(0);

  // Expand: clicking the summary unfolds → the diagram is back.
  await folded.click();
  await sleep(300);
  await expect(page.locator("[data-pane=preview] [data-testid=macro-mermaid]")).toBeVisible();

  // Round-trip: caret into the block reveals the raw markdown (offset-invariant — the
  // canonical source was never mutated by rendering/folding).
  await page.locator("[data-pane=preview] [data-testid=macro-mermaid]").click();
  await sleep(300);
  expect(await page.locator("[data-pane=preview] [data-testid=macro-mermaid]").count()).toBe(0);
  const text = await page.locator("[data-pane=preview] .cm-content").innerText();
  expect(text).toContain("```mermaid");
  expect(text).toContain("graph TD; A-->B;");
});

// #3: an EMPTY macro (mermaid renders nothing for an empty body) must still show a
// visible, named placeholder — so the block widget isn't invisible blank space that the
// caret silently jumps over. Common to all macros (rendered in the shared MacroWidget).
test("an empty macro renders a visible 'Empty …' placeholder (not blank space)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "emptymacro");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  // Insert a CLEAN empty mermaid fence via the slash palette (typing ``` fences directly
  // is unreliable — the editor auto-closes them). The inserted ```mermaid\n\n``` has an
  // empty body → mermaid's liveRender draws nothing → the common placeholder fires.
  await page.keyboard.type("/mermaid");
  await expect(page.getByTestId("slash-palette")).toBeVisible();
  await page.keyboard.press("Enter");
  await sleep(400);
  // Non-vim renders every macro regardless of caret position (#5), so even with the caret
  // inside the fence the placeholder shows.
  const ph = page.locator("[data-pane=preview] [data-testid=macro-empty]");
  await expect(ph).toBeVisible();
  await expect(ph).toContainText("mermaid"); // names the macro
  expect((await ph.boundingBox())!.height).toBeGreaterThan(0); // genuinely occupies space
});
