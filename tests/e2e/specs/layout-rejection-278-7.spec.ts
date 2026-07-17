import { test, expect } from "@playwright/test";
import { openScratch, enterEdit, sleep } from "../helpers";

// #278 (review rejection 2026-07-16, 7 points) — the required anti-tests.
//  A1 one-click slot entry: clicking ANYWHERE in a column (a nested warning included) opens the slot
//     island; before entering, the nested macro is NOT directly interactive (no nested ring / editUI).
//  A2 tab rename: clicking the ACTIVE tab again opens an inline input; Enter round-trips `:::tab[new]`.
//  B3/B5 the × chip: same size AND same in-cell position for an empty and a non-empty column (the prose
//     sibling margin used to push the non-empty one ~14px down), and the glyph fills the chip.
//  B4 the tab × renders even while a slot island is open (it used to vanish with any nested state).
//  B6 a mermaid inside a tab gets the TOP-LEVEL chrome inside the island (✎ + align on hover; ✎ opens
//     the same editUI) — parity by construction (the shared factory).
//  C7 a top-level callout is editable in WYSIWYG (hover ✎ on the panel → the callout editUI).

const CONTENT =
  "intro\n\n::::columns\n:::column\nlead\n\n:::warning[w]\ninner\n:::\n:::\n:::column\n:::\n::::\n\n::::tabs\n:::tab[One]\nlead line\n\n```mermaid\nflowchart TD\n  A-->B\n```\n:::\n:::tab[Two]\ntwo\n:::\n::::\n\ntail\n";

async function setUpPage(page: any) {
  await openScratch(page, "layout-278-7");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(CONTENT);
  await sleep(1000);
  await page.getByText("tail", { exact: true }).click();
  await sleep(400);
}

test("#278-7 A1: one click on a nested macro enters the SLOT island (no nested ring, no direct editUI)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await setUpPage(page);
  // click the nested warning's body — this must open the COLUMN island, not select/edit the warning
  await page.locator("[data-pane=preview]").getByText("inner", { exact: true }).click();
  await sleep(700);
  await expect(page.locator("[data-testid=slot-edit-island]"), "the slot island opened").toHaveCount(1);
  await expect(page.locator(".cm-lp-nested-sel"), "no nested-macro ring").toHaveCount(0);
  await expect(page.locator(".cm-lp-callout-edit"), "no callout editUI opened directly").toHaveCount(0);
  // inside the island the warning behaves like TOP-LEVEL: caret into it reveals raw + the entry pill
  const island = page.locator("[data-testid=slot-edit-island]");
  await island.locator(".cm-content").getByText("inner", { exact: true }).click();
  await sleep(400);
  await expect(island.locator(".cm-lp-macro-richui-raw"), "top-level reveal affordance inside the island").toHaveCount(1);
});

test("#278-7 A2: re-clicking the active tab renames it inline (round-trips :::tab[new])", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await setUpPage(page);
  const active = page.locator(".cm-lp-tab-active").first();
  await expect(active).toHaveText("One");
  await active.click();
  await sleep(400);
  const input = page.getByTestId("tab-rename-input");
  await expect(input, "inline rename input opened").toHaveCount(1);
  await page.keyboard.type("Renamed");
  await page.keyboard.press("Enter");
  await sleep(800);
  await expect(page.locator(".cm-lp-tab").first()).toHaveText("Renamed");
  // round-trip: the SOURCE carries :::tab[Renamed]
  await page.locator("[role=radiogroup] [role=radio]").nth(1).click(); // Source mode
  await sleep(500);
  const src = await page.locator("[data-pane=preview] .cm-content").first().innerText();
  expect(src).toContain(":::tab[Renamed]");
  expect(src).not.toContain(":::tab[One]");
});

test("#278-7 B3+B5: the column × chip — same offset in an empty and a non-empty column; glyph fills the chip", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await setUpPage(page);
  await page.locator("[data-pane=preview] .cm-lp-column").first().hover();
  await sleep(250);
  const geo = await page.evaluate(() => {
    const cols = [...document.querySelectorAll("[data-pane=preview] .cm-lp-column")];
    return cols.map((c) => {
      const x = c.querySelector(".cm-lp-layout-item-remove")!;
      const cr = c.getBoundingClientRect();
      const xr = x.getBoundingClientRect();
      const glyph = getComputedStyle(x, "::before").fontSize;
      return { dTop: Math.round(xr.top - cr.top), h: Math.round(xr.height), glyph: parseFloat(glyph), empty: c.classList.contains("cm-lp-column-empty") };
    });
  });
  expect(geo.length).toBe(2);
  expect(Math.abs(geo[0]!.dTop - geo[1]!.dTop), "× offset identical for empty and non-empty columns").toBeLessThanOrEqual(1);
  for (const g of geo) expect(g.glyph, "the glyph fills the chip (not the old 0.85em)").toBeGreaterThan(g.h * 0.8);
});

test("#278-7 B4: the tab × still renders while a slot island is open", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await setUpPage(page);
  await page.getByText("lead line").click(); // opens the tab's island
  await sleep(700);
  await expect(page.locator("[data-testid=slot-edit-island]")).toHaveCount(1);
  await expect(page.locator(".cm-lp-tab-remove"), "tab × chips render with the island open").toHaveCount(2);
});

test("#278-7 B6: a mermaid inside the island carries the top-level chrome (✎ + align; ✎ opens the editUI)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await setUpPage(page);
  await page.getByText("lead line").click();
  await sleep(700);
  const island = page.locator("[data-testid=slot-edit-island]");
  const merm = island.locator("[data-testid=macro-mermaid]").first();
  await expect(merm, "mermaid renders as a widget inside the island").toHaveCount(1);
  await merm.hover();
  await sleep(300);
  const chrome = await page.evaluate(() => {
    const isl = document.querySelector("[data-testid=slot-edit-island]");
    const w = isl?.querySelector(".cm-lp-macro-wrap");
    const edit = w?.querySelector("[data-testid=macro-edit]");
    return { edit: !!edit, opacity: edit ? getComputedStyle(edit).opacity : null, align: !!w?.querySelector(".cm-lp-align-seg") };
  });
  expect(chrome.edit, "the ✎ exists (same as top-level)").toBe(true);
  expect(parseFloat(chrome.opacity ?? "0"), "✎ shown on hover").toBeGreaterThan(0.5);
  expect(chrome.align, "the align segment exists (same as top-level)").toBe(true);
  // ✎ opens the SAME editUI inside the island (source pane + Done) and the island survives
  const bb = (await island.locator("[data-testid=macro-edit]").first().boundingBox())!;
  await page.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2);
  await sleep(800);
  await expect(page.locator("[data-testid=mermaid-edit-src]"), "the mermaid editUI opened").toHaveCount(1);
  await expect(page.locator("[data-testid=editui-done]"), "with its Done affordance").toHaveCount(1);
  await expect(island, "the island stayed open under the editUI").toHaveCount(1);
});

test("#278-7 C7: a top-level callout is editable in WYSIWYG (hover ✎ → the callout editUI)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "wys-callout-edit");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("intro\n\n:::warning[Careful]\nbody line\n:::\n\ntail\n");
  await sleep(700);
  await page.getByText("tail", { exact: true }).click();
  await sleep(300);
  await page.locator("[role=radiogroup] [role=radio]").nth(3).click(); // WYSIWYG
  await sleep(600);
  const panel = page.locator("[data-pane=preview] .cm-lp-callout-panel").first();
  await expect(panel, "the panel renders in WYSIWYG").toHaveCount(1);
  await panel.hover();
  await sleep(300);
  const chip = page.getByTestId("callout-panel-edit");
  await expect(chip).toHaveCount(1);
  const op = await chip.evaluate((el) => getComputedStyle(el).opacity);
  expect(parseFloat(op), "the ✎ chip shows on panel hover").toBeGreaterThan(0.5);
  await chip.click();
  await sleep(700);
  await expect(page.locator(".cm-lp-callout-edit"), "the callout editUI opened").toHaveCount(1);
});

// ---- #278 (review rejection 2026-07-17, 2 residual points) ----
// P1: inside a slot island the OUTER container wrap is hovered/atom-selected the whole time, so the
//     descendant reveal rules used to light every chrome in the island permanently. Required pins:
//     island non-figure text hover → NO chrome; figure hover → chrome; other -1.5em chrome (callout ✎)
//     doesn't leak either.
// P2: with the island open, re-clicking the ACTIVE tab commits the island and opens the inline rename
//     on the rebuilt widget (supersedes the keep-editing pin; the commit precedes mousedown side
//     effects and the mount goes by container offset + index, never by post-shrink hit-testing).

test("#278-9 P1: island mermaid chrome shows on figure hover ONLY (no leak from island text)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await setUpPage(page);
  await page.locator("[data-pane=preview]").getByText("lead line").click();
  await sleep(700);
  const island = page.locator("[data-testid=slot-edit-island]");
  await expect(island).toHaveCount(1);
  // hover the island's NON-mermaid line → the mermaid ✎ chrome stays hidden AND pointer-inert
  await island.locator(".cm-content").getByText("lead line").hover();
  await sleep(300);
  const edit = island.locator("[data-testid=macro-edit]").first();
  expect(parseFloat(await edit.evaluate((el) => getComputedStyle(el).opacity)), "chrome hidden on text hover").toBeLessThan(0.1);
  const rowPE = await island.locator(".cm-lp-macro-btnrow").first().evaluate((el) => getComputedStyle(el).pointerEvents);
  expect(rowPE, "the -1.5em btnrow must not steal the line's hover").toBe("none");
  // hover the figure → the chrome reveals
  await island.locator("[data-testid=macro-mermaid]").first().hover();
  await sleep(300);
  expect(parseFloat(await edit.evaluate((el) => getComputedStyle(el).opacity)), "chrome shows on figure hover").toBeGreaterThan(0.5);
});

test("#278-9 P1b: a callout's -1.5em ✎ inside an island doesn't leak on unrelated text hover", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await setUpPage(page);
  // the columns container: first column holds "lead" + a nested warning
  await page.locator("[data-pane=preview]").getByText("lead", { exact: true }).click();
  await sleep(700);
  const island = page.locator("[data-testid=slot-edit-island]");
  await expect(island).toHaveCount(1);
  await island.locator(".cm-content").getByText("lead", { exact: true }).hover();
  await sleep(300);
  const chips = island.locator(".cm-lp-callout-panel-edit, [data-testid=macro-edit]");
  const n = await chips.count();
  for (let i = 0; i < n; i++) {
    const op = parseFloat(await chips.nth(i).evaluate((el) => getComputedStyle(el).opacity));
    expect(op, `chrome ${i} stays hidden hovering unrelated island text`).toBeLessThan(0.1);
  }
});

test("#278-9 P2: active-tab re-click with the island open commits it AND opens the rename", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await setUpPage(page);
  await page.locator("[data-pane=preview]").getByText("lead line").click();
  await sleep(700);
  const island = page.locator("[data-testid=slot-edit-island]");
  await expect(island).toHaveCount(1);
  await island.locator(".cm-content").getByText("lead line").click();
  await page.keyboard.press("End");
  await page.keyboard.type(" EDITED");
  await sleep(300);
  await page.locator(".cm-lp-tab-active").first().click();
  await sleep(600);
  await expect(island, "the island committed + closed").toHaveCount(0);
  const input = page.getByTestId("tab-rename-input");
  await expect(input, "the rename mounted on the REBUILT widget").toHaveCount(1);
  await page.keyboard.type("NewName");
  await page.keyboard.press("Enter");
  await sleep(800);
  await expect(page.locator(".cm-lp-tab").first()).toHaveText("NewName");
  await page.locator("[role=radiogroup] [role=radio]").nth(1).click(); // Source mode
  await sleep(500);
  const src = await page.locator("[data-pane=preview] .cm-content").first().innerText();
  expect(src, "the island edit committed before the rename").toContain("lead line EDITED");
  expect(src, "the rename round-trips the fence head").toContain(":::tab[NewName]");
});

// ---- #278 (review rejection 2026-07-17, 3 new points) ----
// ①: inside an island the Ctrl+↵ pill is HOVER-ONLY — panel-click entry parks the caret on the head
//     line, and the top-level keyboard perma-show (macroRawHead) read as "the hint never goes away".
//     Plus the GENERALIZED boundary pin: no island chrome lights from hovering unrelated island text.
// ②③ invariant pins (not reproduced in probing — pinned so the class stays caught): no isolated
//     colon ever renders in the island DOM, and the island's scroll state stays stable while the
//     caret approaches the callout from below.

test("#278-10 ①: the island pill shows on the callout's own hover ONLY (not caret-parked, not other text)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await setUpPage(page);
  await page.locator("[data-pane=preview]").getByText("lead", { exact: true }).click();
  await sleep(700);
  const island = page.locator("[data-testid=slot-edit-island]");
  await expect(island).toHaveCount(1);
  // panel-click entry: the caret parks on the warning's head line, raw reveals, the pill mounts
  await island.locator(".cm-content").getByText("inner", { exact: true }).click();
  await sleep(500);
  const pill = island.locator(".cm-lp-macro-richui-raw").first();
  await expect(pill).toBeAttached();
  // mouse far away → the pill must NOT stay lit from the parked caret
  await page.mouse.move(10, 10);
  await sleep(300);
  expect(parseFloat(await pill.evaluate((el) => getComputedStyle(el).opacity)), "no perma-show with the mouse away").toBeLessThan(0.1);
  // hovering the revealed raw line brings it back
  await island.locator(".cm-content").getByText("inner", { exact: true }).hover();
  await sleep(300);
  expect(parseFloat(await pill.evaluate((el) => getComputedStyle(el).opacity)), "own-zone hover reveals").toBeGreaterThan(0.5);
  // hovering UNRELATED island text does not
  await island.locator(".cm-content").getByText("lead", { exact: true }).hover();
  await sleep(300);
  expect(parseFloat(await pill.evaluate((el) => getComputedStyle(el).opacity)), "unrelated text hover never lights it").toBeLessThan(0.1);
});

test("#278-10 ① generalized: NO island chrome lights from hovering neutral island text", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await setUpPage(page);
  await page.locator("[data-pane=preview]").getByText("lead line").click();
  await sleep(700);
  const island = page.locator("[data-testid=slot-edit-island]");
  await expect(island).toHaveCount(1);
  await island.locator(".cm-content").getByText("lead line").hover();
  await sleep(300);
  const CHROME = ".cm-lp-macro-edit, .cm-lp-macro-align, .cm-lp-macro-retarget, .cm-lp-macro-richui-raw, .cm-lp-callout-panel-edit";
  const ops = await island.locator(CHROME).evaluateAll((els) => els.map((el) => ({ c: el.className.slice(0, 60), op: getComputedStyle(el).opacity })));
  for (const { c, op } of ops) expect(parseFloat(op), `chrome [${c}] hidden on neutral hover`).toBeLessThan(0.1);
});

test("#278-10 ②③ invariants: no isolated colon in island DOM; stable scroll state on from-below approach", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await setUpPage(page);
  await page.locator("[data-pane=preview]").getByText("lead", { exact: true }).click();
  await sleep(700);
  const island = page.locator("[data-testid=slot-edit-island]");
  await expect(island).toHaveCount(1);
  // ② the raw reveal must show full fences only — a colon-bearing line is a fence line (:::...), never
  //   a stray fragment like ":" or "::" (the nested colon-count off-by-one class)
  await island.locator(".cm-content").getByText("inner", { exact: true }).click();
  await sleep(500);
  const lines = await island.locator(".cm-line").evaluateAll((els) => els.map((el) => el.textContent ?? ""));
  for (const t of lines.filter((t) => t.includes(":"))) {
    expect(t, `colon line is a full fence: "${t}"`).toMatch(/:{3,}/);
  }
  // ③ walk the caret up from the bottom (atomic skip over the panel) — the island's scroll geometry
  //   must not oscillate (no transient scrollbar)
  await island.locator(".cm-content").getByText("lead", { exact: true }).click();
  await sleep(300);
  await page.keyboard.press("Control+End");
  await sleep(200);
  const states: boolean[] = [];
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press("ArrowUp");
    await sleep(120);
    states.push(await island.locator(".cm-scroller").first().evaluate((el) => el.scrollHeight > el.clientHeight));
  }
  expect(new Set(states).size, "overflow state never flips during the walk").toBeLessThanOrEqual(1);
});
