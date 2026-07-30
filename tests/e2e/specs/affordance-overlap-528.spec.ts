import { test, expect, type Page } from "@playwright/test";
import { openScratch, enterEdit, sleep } from "../helpers";

// #528 red-check, pinned: across a sweep of pointer positions and entry states, the set of VISIBLE
// block affordances has pairwise rectangle intersection ZERO (parent/child containment excluded — that is
// nesting, not collision), and a still pointer sees ONE stable visible set (the flicker half, achieved in
// a6184ad0, must not regress). Real Chromium: the collision was born from two absolutely-positioned
// elements with different offset parents — exactly what no unit DOM can measure.

const DOC = `::::columns
:::column
:::note
AAA nested note
:::
:::
:::column
BBB text
:::
::::

\`\`\`mermaid
graph TD; A-->B;
\`\`\`

end
`;

const AFFORDANCE_SEL = ".cm-macro-presence-box, .cm-lp-macro-btnrow, .cm-lp-macro-edit, .cm-lp-nested-macro-edit, .cm-lp-macro-richui-raw, .cm-lp-layout-item-add";

async function visibleOverlaps(page: Page): Promise<string[]> {
  return page.evaluate((selArg: string) => {
    const sel = selArg;
    const els = Array.from(document.querySelectorAll<HTMLElement>(sel));
    const vis = els.filter((e) => {
      const cs = getComputedStyle(e);
      const r = e.getBoundingClientRect();
      return cs.visibility !== "hidden" && cs.display !== "none" && parseFloat(cs.opacity || "1") > 0.01 && r.width > 0 && r.height > 0;
    });
    const out: string[] = [];
    for (let i = 0; i < vis.length; i++) for (let j = i + 1; j < vis.length; j++) {
      const a = vis[i]!, b = vis[j]!;
      if (a.contains(b) || b.contains(a)) continue;
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      if (ra.left < rb.right && rb.left < ra.right && ra.top < rb.bottom && rb.top < ra.bottom) {
        out.push(`${a.className.split(" ")[0]}×${b.className.split(" ")[0]} @${Math.round(ra.x)},${Math.round(ra.y)}/${Math.round(rb.x)},${Math.round(rb.y)}`);
      }
    }
    return out;
  }, AFFORDANCE_SEL);
}

async function setup(browser: import("@playwright/test").Browser) {
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
  await openScratch(page, `aff528-${Date.now().toString(36)}`);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content >> nth=0");
  await page.keyboard.insertText(DOC);
  await sleep(1500);
  await page.getByText("end").click(); // caret away → everything renders as widgets
  await sleep(400);
  return page;
}

test("#528 no two visible affordances intersect — swept across hover positions and entry states", async ({ browser }) => {
  const page = await setup(browser);
  const wrap = page.locator("[data-pane=preview] .cm-lp-macro-wrap").first();
  const bb = (await wrap.boundingBox())!;
  const mermaid = page.locator("[data-pane=preview] [data-testid=macro-mermaid]").first();
  const mb = (await mermaid.boundingBox())!;

  const spots: [string, number, number][] = [
    ["container top-left", bb.x + 30, bb.y + 6],
    ["container gutter", bb.x + 30, bb.y - 10],
    ["container center", bb.x + bb.width / 2, bb.y + Math.min(bb.height / 2, 150)],
    ["mermaid center", mb.x + mb.width / 2, mb.y + Math.min(mb.height / 2, 120)],
  ];
  const sweep = async (state: string) => {
    for (const [label, x, y] of spots) {
      await page.mouse.move(x, y);
      await sleep(450);
      expect(await visibleOverlaps(page), `${state} / ${label}`).toEqual([]);
    }
  };

  await sweep("cold");

  // entry state: into the nested slot (island), Esc back out — the states measured around
  await page.getByText("AAA nested note").click();
  await sleep(600);
  await page.keyboard.press("Escape");
  await sleep(600);
  await sweep("after nested entry + Esc");
});

test("#528 a still pointer sees ONE stable visible-affordance set (no flicker)", async ({ browser }) => {
  const page = await setup(browser);
  const wrap = page.locator("[data-pane=preview] .cm-lp-macro-wrap").first();
  const bb = (await wrap.boundingBox())!;
  await page.mouse.move(bb.x + 30, bb.y - 10); // the gutter, where chrome lives
  await sleep(500);
  const sets = new Set<string>();
  for (let i = 0; i < 8; i++) {
    const key = await page.evaluate((sel) => {
      const els = Array.from(document.querySelectorAll<HTMLElement>(sel));
      return els
        .filter((e) => {
          const cs = getComputedStyle(e);
          const r = e.getBoundingClientRect();
          return cs.visibility !== "hidden" && cs.display !== "none" && parseFloat(cs.opacity || "1") > 0.01 && r.width > 0 && r.height > 0;
        })
        .map((e) => e.className.split(" ")[0])
        .sort()
        .join("|");
    }, AFFORDANCE_SEL);
    sets.add(key);
    await sleep(200);
  }
  expect(sets.size, `distinct visible sets over 8 still samples: ${[...sets].join(" || ")}`).toBe(1);
});
