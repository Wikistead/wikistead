import { test, expect, type Page } from "@playwright/test";
import { openScratch, enterEdit, sleep } from "../helpers";

// #193: the sidebar page-row must, at ANY width (drag-resizable 180–480px), keep
//   (1) the name truncated with an ellipsis when it can't fit,
//   (2) the draft badge / unpublished dot fully visible (never clipped),
//   (3) no horizontal overflow of the row (highlight == slot),
// and the sidebar background must NOT leak in edit mode.
// happy-dom has no layout engine, so this is verified in a REAL browser with real
// widths (the reviewer's demand: measure the actual flex shrink, don't guess classes).

const LONG = "Abcdefghijklmnop Qrstuvwxyz 0123456789 the quick brown fox jumps over";

async function setSidebarWidth(page: Page, px: number) {
  await page.evaluate((w) => document.documentElement.style.setProperty("--sidebar-w", `${w}px`), px);
  await sleep(400); // ResizeObserver → Tree width prop → row re-layout
}

// Geometry of the open page's own sidebar row (it is selected, always rendered).
async function rowGeom(page: Page) {
  const row = page.locator("[data-testid=tree-page][data-selected]").first();
  const name = row.locator("[data-testid=tree-page-name]");
  const aside = page.locator("aside").first();
  return {
    name: await name.evaluate((el) => ({
      scrollW: el.scrollWidth,
      clientW: el.clientWidth,
      ellipsis: getComputedStyle(el).textOverflow,
      right: el.getBoundingClientRect().right,
    })),
    // The badge (draft) OR the unpublished dot — whichever this row has.
    badge: await row.evaluate((el) => {
      const b = el.querySelector("[data-testid=tree-draft-badge],[data-testid=unpublished-dot]") as HTMLElement | null;
      return b ? { right: b.getBoundingClientRect().right, width: b.getBoundingClientRect().width } : null;
    }),
    rowOverflow: await row.evaluate((el) => {
      const inner = el.firstElementChild as HTMLElement; // INNER flex row
      return inner.scrollWidth - inner.clientWidth; // >0 ⇒ horizontal overflow
    }),
    asideRight: await aside.evaluate((el) => el.getBoundingClientRect().right),
    asideNoScroll: await aside.evaluate((el) => el.scrollWidth <= el.clientWidth),
  };
}

test("#193 sidebar row: long name truncates + badge stays visible across 180–480px", async ({ page }) => {
  await openScratch(page, LONG); // a fresh DRAFT page (has the draft badge) with a very long title

  for (const w of [180, 300, 480, 180]) {
    await setSidebarWidth(page, w);
    const g = await rowGeom(page);
    // (3) the row never overflows horizontally (highlight == slot, no bleed).
    expect(g.rowOverflow, `row overflow at ${w}px`).toBeLessThanOrEqual(1);
    expect(g.asideNoScroll, `aside no h-scroll at ${w}px`).toBe(true);
    // (2) the badge is fully within the sidebar (never clipped by the right edge).
    if (g.badge) expect(g.badge.right, `badge clipped at ${w}px`).toBeLessThanOrEqual(g.asideRight + 1);
    // (1) at narrow widths the long name must be clipped→ellipsis (scrollW>clientW);
    //     ellipsis is always the declared behaviour.
    expect(g.name.ellipsis, `ellipsis decl at ${w}px`).toBe("ellipsis");
    if (w <= 300) expect(g.name.scrollW, `name truncated at ${w}px`).toBeGreaterThan(g.name.clientW);
    // and the name never spills past the sidebar edge.
    expect(g.name.right, `name past edge at ${w}px`).toBeLessThanOrEqual(g.asideRight + 1);
  }
});

// The element topmost at a point inside the sidebar must belong to the sidebar subtree
// (an <aside> ancestor) — never a main/editor element overhanging into it (a "leak").
async function topElementOverSidebarIsInAside(page: Page) {
  const box = await page.locator("aside").first().boundingBox();
  if (!box) return false;
  const x = box.x + box.width / 2;
  const y = box.y + 40; // near the top of the tree
  return page.evaluate(({ x, y }) => {
    let el = document.elementFromPoint(x, y) as HTMLElement | null;
    while (el) { if (el.tagName.toLowerCase() === "aside") return true; el = el.parentElement; }
    return false;
  }, { x, y });
}

test("#193 sidebar background does not leak in edit mode", async ({ page }) => {
  await openScratch(page, "Bg Leak Probe");
  const aside = page.locator("aside").first();
  const viewBg = await aside.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(await topElementOverSidebarIsInAside(page), "view: non-sidebar element over sidebar").toBe(true);
  await enterEdit(page);
  // The <aside> keeps its panel background in edit mode, and no editor/main element
  // overhangs the sidebar box (surfaceKey==="edit" must not change the sidebar paint).
  const editBg = await aside.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(editBg, "aside background differs edit vs view").toBe(viewBg);
  expect(await topElementOverSidebarIsInAside(page), "edit: non-sidebar element over sidebar (leak)").toBe(true);
});
