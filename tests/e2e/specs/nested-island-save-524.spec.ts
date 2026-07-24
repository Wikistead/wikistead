import { test, expect } from "@playwright/test";
import { openScratch, enterEdit, sleep } from "../helpers";

// #524: island-in-island data loss. A slot island (columns/tabs) can host a DEEPER slot island. The deeper
// island holds its own private nested doc and only writes back into its parent island on ITS OWN commit.
// The bug: clicking the OUTERMOST surface in one gesture fired the outer island's pointerdown-capture commit
// first — it wrote its (stale) getValue() that omitted the inner island's pending edits, then the rebuild
// destroyed the inner island before it could flush → the inner edit was silently LOST. The fix flushes any
// open nested island (innermost-first) before the outer island reads its own body. The decision variable is
// NESTING DEPTH (island-in-island), not the container type — so both combinations are pinned.
const content = (p: any) => p.locator("[data-pane=preview] .cm-content").innerText();

// Two nested shapes. Outer container carries MORE colons than the one nested inside it (the render convention).
const CASES = [
  {
    label: "tabs-in-column",
    doc: "top\n\n::::::columns\n:::::column\n::::tabs\n:::tab[One]\nINNER\n:::\n::::\n:::::\n:::::column\nSIDE\n:::::\n::::::\n\nbot\n",
    // open the outer COLUMN island, then the inner TAB panel
    openOuter: (p: any) => p.locator("[data-pane=preview] .cm-lp-column").first().click(),
    openInner: (p: any) => p.locator("[data-testid=slot-edit-island] .cm-lp-tabpanel-active").click(),
  },
  {
    label: "column-in-tab",
    doc: "top\n\n::::::tabs\n:::::tab[One]\n::::columns\n:::column\nINNER\n:::\n:::column\nCCC\n:::\n::::\n:::::\n::::::\n\nbot\n",
    // open the outer TAB island, then the inner first COLUMN
    openOuter: (p: any) => p.locator("[data-pane=preview] .cm-lp-tabpanel-active").click(),
    openInner: (p: any) => p.locator("[data-testid=slot-edit-island] .cm-lp-column").first().click(),
  },
] as const;

for (const c of CASES) {
  test(`#524: a nested island's edit survives a one-click exit to the outermost surface — ${c.label}`, async ({ browser }) => {
    const page = await (await browser.newContext()).newPage();
    const errs: string[] = []; page.on("pageerror", (e) => errs.push(String(e)));
    await openScratch(page, `nested-save-${c.label}-${Date.now().toString(36)}`);
    await enterEdit(page);
    await page.click("[data-pane=preview] .cm-content");
    await page.keyboard.insertText(c.doc);
    await sleep(900);
    await page.getByText("bot", { exact: true }).click(); // caret OUT → the container widget renders
    await sleep(300);

    // 1) open the OUTER slot island
    await c.openOuter(page);
    await sleep(400);
    await expect(page.locator(".cm-lp-slot-edit-island"), "outer island mounted").toHaveCount(1);

    // 2) open the INNER (nested) slot island — now island-in-island
    await c.openInner(page);
    await sleep(400);
    await expect(page.locator(".cm-lp-slot-edit-island"), "inner island mounted (island-in-island)").toHaveCount(2);

    // the inner island is focused after a single click — type an edit onto INNER.
    const inInner = await page.evaluate(() => {
      const islands = document.querySelectorAll("[data-testid=slot-edit-island]");
      const deepest = islands[islands.length - 1];
      return !!deepest && deepest.contains(document.activeElement);
    });
    expect(inInner, "the inner island is focused after a single click").toBe(true);
    await page.keyboard.press("Control+End");
    await page.keyboard.type(" EDIT");
    await sleep(200);

    // 3) click the OUTERMOST surface in ONE gesture (the reported data-loss trigger).
    await page.getByText("bot", { exact: true }).click();
    await sleep(600);

    // 4) the inner edit must be in the canonical source (it was being LOST before the fix).
    await page.getByTestId("displaymode-source").click();
    await sleep(300);
    const src = await content(page);
    expect(src, `nested edit must survive the one-click exit (${c.label})`).toContain("INNER EDIT");
    // structure round-trips: both container fences and the inner slot fence are intact.
    expect(src).toContain(":::tab[");
    expect(src).toContain(":::column");
    expect(errs, errs.join(" | ")).toHaveLength(0);
  });
}

// Control: the SINGLE-island case (no nesting) must keep saving on a one-click exit — the fix must not
// regress the plain path (this is the "YES / saved" row in the ticket's matrix).
test("#524 control: a single (non-nested) island still commits on a one-click outside exit", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, `single-save-${Date.now().toString(36)}`);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("top\n\n::::columns\n:::column\nAAA\n:::\n:::column\nBBB\n:::\n::::\n\nbot\n");
  await sleep(800);
  await page.getByText("bot", { exact: true }).click();
  await sleep(200);
  await page.locator("[data-pane=preview] .cm-lp-column").first().click();
  await sleep(400);
  await expect(page.locator("[data-testid=slot-edit-src]")).toBeVisible();
  await page.keyboard.press("Control+End");
  await page.keyboard.type(" MORE");
  await sleep(150);
  await page.getByText("bot", { exact: true }).click();
  await sleep(400);
  await page.getByTestId("displaymode-source").click();
  await sleep(250);
  const s = await content(page);
  expect(s).toContain("AAA MORE");
  expect(s).toContain("BBB");
});
