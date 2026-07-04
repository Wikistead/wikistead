import { test, expect } from "@playwright/test";
import { openScratch, enterEdit, sleep } from "../helpers";

// ADR-036 / #84 (comment 741): a HOVER-FOLLOWING drag handle. Hovering a top-level block shows a grip
// just OUTSIDE the block's left edge (both plain paragraphs and replaced widget atoms); moving away hides
// it; dragging it reorders the block as one Y.Text transaction. Verified in a real browser — the grip's
// visibility, its position relative to the block, and the drag are all rendered/geometry concerns that
// don't exist in happy-dom. This is the model that replaced the always-on far-left gutter grip (which the
// reviewer couldn't associate with a block — 10+ bounces).

async function seed(page: import("@playwright/test").Page) {
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("first paragraph here\n\n```mermaid\ngraph TD\nA-->B\n```\n\n:::note\ncallout body\n:::\n\nlast paragraph\n");
  await sleep(700);
  await page.getByText("last paragraph").click(); // caret off the blocks so atoms render as widgets
  await sleep(200);
}
const grip = (page: import("@playwright/test").Page) => page.locator("[data-testid=block-grip]");
const gripState = (page: import("@playwright/test").Page, blockSelectorX: number) =>
  page.evaluate((bx) => {
    const g = document.querySelector("[data-testid=block-grip]") as HTMLElement;
    const r = g.getBoundingClientRect();
    return { display: getComputedStyle(g).display, rightOfBlockLeft: r.right - bx, y: Math.round(r.y), h: Math.round(r.height) };
  }, blockSelectorX);

test("#84: the drag grip is hidden until a block is hovered, then sits just left of it", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "blockdrag-hover");
  await enterEdit(page);
  await seed(page);

  // hidden at rest (pointer not on a block)
  await page.mouse.move(4, 4);
  await sleep(150);
  expect(await grip(page).evaluate((g) => getComputedStyle(g).display)).toBe("none");

  // hover a PARAGRAPH → grip appears, just OUTSIDE its left edge (its right edge is left of the block left)
  const para = page.getByText("first paragraph here");
  const pb = (await para.boundingBox())!;
  await page.mouse.move(pb.x + 40, pb.y + pb.height / 2);
  await sleep(200);
  const onPara = await gripState(page, pb.x);
  expect(onPara.display).toBe("block");
  expect(onPara.rightOfBlockLeft, "grip sits at/left of the block's left edge (not far away, not deep inside)").toBeLessThan(12);
  expect(onPara.rightOfBlockLeft).toBeGreaterThan(-60); // adjacent, not off in the far-left gutter

  // hover a WIDGET ATOM (mermaid) → grip also appears (the widgetMarker bounce fix, now via capture+false)
  const mer = page.getByTestId("macro-mermaid").first();
  const mb = (await mer.boundingBox())!;
  await page.mouse.move(mb.x + 60, mb.y + 30);
  await sleep(200);
  expect((await gripState(page, mb.x)).display).toBe("block");

  // leaving the editor hides it
  await page.mouse.move(4, 4);
  await sleep(200);
  expect(await grip(page).evaluate((g) => getComputedStyle(g).display)).toBe("none");
});

test("#84: dragging the grip reorders the block (one Y.Text transaction)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "blockdrag-move");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("AAA first\n\nBBB second\n\nCCC third\n");
  await sleep(400);
  await page.getByText("CCC third").click();
  await sleep(150);

  // hover AAA → grip appears; grab it and drop onto CCC → AAA moves below.
  const aaa = page.getByText("AAA first");
  const ab = (await aaa.boundingBox())!;
  await page.mouse.move(ab.x + 30, ab.y + ab.height / 2);
  await sleep(200);
  const g = (await grip(page).boundingBox())!;
  const ccc = page.getByText("CCC third");
  const cb = (await ccc.boundingBox())!;
  await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
  await page.mouse.down();
  await page.mouse.move(cb.x + 20, cb.y + 4, { steps: 12 });
  await page.mouse.up();
  await sleep(300);

  const text = await page.locator("[data-pane=preview] .cm-content").innerText();
  const iA = text.indexOf("AAA"), iB = text.indexOf("BBB"), iC = text.indexOf("CCC");
  expect(iB).toBeLessThan(iA); // BBB now before AAA (AAA moved down)
  expect(iA).toBeGreaterThanOrEqual(0); // AAA still present (block intact)
  expect(iC).toBeGreaterThanOrEqual(0);
});
