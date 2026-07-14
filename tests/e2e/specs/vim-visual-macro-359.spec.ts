import { test, expect, type Page } from "@playwright/test";
import { openScratch, enterEdit, sleep } from "../helpers";

const content = (p: Page) => p.locator("[data-pane=preview] .cm-content").innerText();
const headLine = (p: Page) => p.evaluate(() => (window as Window & { __lpHeadLine?: number }).__lpHeadLine ?? -1);

// #359: in vim × Live, a NON-EMPTY visual selection dragged across a block macro (details/callout/mermaid…) used
// to flip the macro atom↔raw mid-selection (reveal fired on ANY selection overlap), which churned
// `EditorView.atomicRanges` and warped vim's visual head (the project design notes: vim cursor respects atomicRanges). Reveal is
// now an EMPTY-CARET affordance, so a visual selection keeps the macro an atom and the selection extends cleanly.
test("#359: vim V-selection across a :::details keeps it a rendered atom (no reveal, no cursor warp)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "vim-visual-details-359");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("top line\n\n:::details[More info]\nthe hidden body\n:::\n\nbottom line\n");
  await sleep(400);
  await page.getByText("bottom line").click(); // caret off the block → the details renders as an atom box
  await sleep(200);
  const box = page.locator("[data-pane=preview] [data-testid=macro-details]");
  await expect(box).toBeVisible();

  await page.getByTestId("vim-toggle").click();
  await sleep(300);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.press("Escape");
  await page.keyboard.type("gg"); // top of doc (the "top line")
  await sleep(120);

  // Line-visual from the top, then extend DOWN across the details block. The head must advance one DOC line per
  // `j` (monotonic, no warp), and the details must NEVER reveal its raw `:::details` source (stay an atom).
  await page.keyboard.press("V");
  await sleep(80);
  const lines: number[] = [await headLine(page)];
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press("j");
    await sleep(80);
    lines.push(await headLine(page));
    expect(await content(page), `step ${i}: details stayed an atom (no raw reveal)`).not.toContain(":::details");
    await expect(box, `step ${i}: the details box is still rendered`).toBeVisible();
  }
  // Head advanced monotonically (never jumped backwards / warped) as the selection grew over the atom.
  for (let i = 1; i < lines.length; i++) expect(lines[i]!, `head line non-decreasing: ${lines}`).toBeGreaterThanOrEqual(lines[i - 1]!);
  expect(lines[lines.length - 1]!, "the selection reached past the block").toBeGreaterThan(lines[0]!);
  // (Empty-caret reveal-to-edit is unchanged — covered by macro-details / mermaid-reveal-243.)
});
