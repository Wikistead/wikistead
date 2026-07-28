import { test, expect } from "@playwright/test";
import { openScratch, enterEdit, sleep } from "../helpers";

// #548: the ⇆ retarget button is gone — it duplicated Ctrl+Enter exactly (#332routes Ctrl+Enter
// on a selected atomSelectable embed through the SAME changeEmbedTarget) and its hand-placed slot
// collided with the Ctrl+Enter hint. These pin the ONE remaining door for BOTH embed kinds (the
// ticket's rule: pinning only one leaves the other free to break green), the button's absence, and
// the anti-overlap acceptance: no two visible affordances on a hovered/selected embed overlap.

test("#548: Ctrl+Enter on embed-external opens the URL modal; the ⇆ button no longer exists", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, `ce548x-${Date.now().toString(36)}`);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content >> nth=0");
  await page.keyboard.insertText("top\n\n:::embed-external\nhttps://example.com/watch\n:::\n\nbot\n");
  await sleep(800);
  await page.getByText("bot").click();
  await sleep(200);

  // Click selects the atom (atomSelectable: card + ring, no raw reveal)…
  await page.locator("[data-pane=preview] [data-testid=macro-embed-external]").first().click();
  await sleep(300);
  // …and there is no ⇆ anywhere (a leftover button would make this pin vacuous — the ticket's check).
  await expect(page.locator("[data-testid=embed-change-target]")).toHaveCount(0);

  await page.keyboard.press("Control+Enter");
  await expect(page.getByTestId("embed-url-input")).toBeVisible({ timeout: 4000 });
  await expect(page.getByTestId("embed-url-input")).toHaveValue("https://example.com/watch"); // a re-entry, not a blank prompt
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("embed-url-input")).toHaveCount(0);
});

test("#548: Ctrl+Enter on embed-page opens the page PICKER (the sibling kind gets its own pin)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, `ce548p-${Date.now().toString(36)}`);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content >> nth=0");
  await page.keyboard.insertText("top\n\n:::embed-page\n00000000-0000-4000-8000-000000000000\n:::\n\nbot\n");
  await sleep(800);
  await page.getByText("bot").click();
  await sleep(200);

  await page.locator("[data-pane=preview] [data-testid^=macro-embed-page]").first().click();
  await sleep(300);
  await page.keyboard.press("Control+Enter");
  await expect(page.getByTestId("embed-picker-input")).toBeVisible({ timeout: 4000 });
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("embed-picker-input")).toHaveCount(0);
});

test("#548: no two visible affordances on a hovered+selected embed overlap (the collision that motivated this)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, `ce548o-${Date.now().toString(36)}`);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content >> nth=0");
  await page.keyboard.insertText("top\n\n:::embed-external\nhttps://example.com/watch\n:::\n\nbot\n");
  await sleep(800);
  await page.getByText("bot").click();
  await sleep(200);
  const wrap = page.locator("[data-pane=preview] .cm-lp-macro-wrap").first();
  await wrap.click(); // selected
  await wrap.hover(); // + hovered — the worst case for affordance crowding
  await sleep(400);

  const overlaps = await wrap.evaluate((root) => {
    const els = Array.from(root.querySelectorAll<HTMLElement>("button, .cm-lp-macro-hint, [class*=affordance], [class*=cm-lp-macro-]"))
      .filter((el) => {
        const cs = getComputedStyle(el);
        if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
    const rects = els.map((el) => ({ el: el.className, r: el.getBoundingClientRect() }));
    const bad: string[] = [];
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i]!, b = rects[j]!;
        // containment (a chrome row containing its buttons) is NOT an overlap — the ticket's rule
        const contains = (x: DOMRect, y: DOMRect) => x.left <= y.left && x.top <= y.top && x.right >= y.right && x.bottom >= y.bottom;
        if (contains(a.r, b.r) || contains(b.r, a.r)) continue;
        const ix = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
        const iy = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
        if (ix > 1 && iy > 1) bad.push(`${a.el} × ${b.el} (${ix.toFixed(0)}×${iy.toFixed(0)})`);
      }
    }
    return bad;
  });
  expect(overlaps, overlaps.join(" | ")).toHaveLength(0);
});
