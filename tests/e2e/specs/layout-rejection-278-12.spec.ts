import { test, expect } from "@playwright/test";
import { openScratch, enterEdit, sleep } from "../helpers";

// #278(review rejection #4, 2026-07-17) +— the required anti-tests.
//  ① Chrome reveal is DIRECT-CHILD only: with a columns/tabs CONTAINER atom-selected, the nested
//     warning's ✎/Ctrl+↵ chrome stays hidden (the descendant-selector leak, flagged 4 times); the
//     wrap's OWN chrome still reveals.
//  ② The island's vim fat cursor never paints hidden source: the caret-guard classes reach the island
//     via the shared factory, and the tokens.css nested-editor restore rule (4-class specificity) no
//     longer defeats them — computed glyph color is transparent, same as top-level.
//  ④ The tab's right ×-slot padding exists ONLY while the × renders (edit surface); Reading gets
//     symmetric padding (no phantom right gap).
//  ⑤enter→exit→re-enter round-trips (both exit paths), and a normal-mode Escape COMMITS the
//     island's pending edit (it used to be silently discarded — the click-out path always committed).

test("#278-12 ①: an atom-selected container reveals its OWN chrome only (nested ✎ stays hidden)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "layout-278-12a");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("intro\n\n::::columns\n:::column\nlead\n\n:::warning[w]\ninner\n:::\n:::\n:::column\n:::\n::::\n\ntail\n");
  await sleep(900);
  await page.getByTestId("vim-toggle").click();
  await sleep(300);
  // WYSIWYG: the nested hover-✎ buttons exist in the DOM there (theleak's subject — the old
  // descendant reveal lit them all up whenever the CONTAINER was atom-selected)
  await page.locator("[role=radiogroup] [role=radio]").nth(3).click();
  await sleep(600);
  // park below, then `k` up onto the container block atom (an empty line sits between: press until
  // the atom selects, bounded)
  await page.getByText("tail", { exact: true }).click();
  await sleep(300);
  const selWrap = page.locator(".cm-lp-macro-wrap.cm-lp-atom-sel");
  for (let i = 0; i < 4 && (await selWrap.count()) === 0; i++) {
    await page.keyboard.press("k");
    await sleep(400);
  }
  await expect(selWrap, "the container atom is selected").toHaveCount(1);
  // the NESTED warning's chrome must NOT reveal from the container's selection (direct-child rule)
  const nestedEdits = selWrap.locator("[data-mac-pos] .cm-lp-nested-macro-edit-hover");
  const nestedCount = await nestedEdits.count();
  expect(nestedCount, "the nested warning renders its (hidden) hover-✎").toBeGreaterThan(0);
  for (let i = 0; i < nestedCount; i++) {
    const op = await nestedEdits.nth(i).evaluate((el) => getComputedStyle(el).opacity);
    expect(op, "nested ✎ chrome stays hidden while the CONTAINER is atom-selected").toBe("0");
  }
  // the wrap's OWN direct chrome still reveals (the `>` conversion must not hide it)
  const ownEdit = selWrap.locator("> .cm-lp-macro-btnrow .cm-lp-macro-edit").first();
  if (await ownEdit.count()) {
    expect(await ownEdit.evaluate((el) => getComputedStyle(el).opacity), "own chrome reveals on atom-sel").toBe("1");
  }
});

test("#278-12 ②: the island vim fat cursor is TRANSPARENT on an atom (no source-char leak); top-level same", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "layout-278-12b");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("::::tabs\n:::tab[One]\nlead\n\n```mermaid\nflowchart TD\n  A-->B\n```\nbelow\n:::\n:::tab[Two]\ntwo\n:::\n::::\n\nmid\n\n```mermaid\nflowchart TD\n  C-->D\n```\ntail\n");
  await sleep(900);
  await page.getByTestId("vim-toggle").click();
  await sleep(300);
  await page.locator("[role=radiogroup] [role=radio]").nth(3).click(); // WYSIWYG (no caret-in reveal)
  await sleep(600);
  // top-level control: caret onto the top-level mermaid atom → guard class + transparent glyph
  await page.getByText("tail", { exact: true }).click();
  await sleep(300);
  await page.keyboard.press("k");
  await sleep(400);
  const outerColor = await page.evaluate(() => {
    const fc = document.querySelector("[data-pane=preview] .cm-fat-cursor");
    return fc ? getComputedStyle(fc).color : "no-fat-cursor";
  });
  expect(outerColor, "top-level fat cursor glyph is transparent on an atom").toBe("rgba(0, 0, 0, 0)");
  // island: enter tab One, caret onto the nested mermaid atom → SAME transparency (②)
  await page.locator("[data-pane=preview]").getByText("lead", { exact: true }).click();
  await sleep(800);
  const island = page.locator("[data-testid=slot-edit-island]");
  await expect(island).toHaveCount(1);
  await island.locator(".cm-content").getByText("below", { exact: true }).click();
  await sleep(300);
  await page.keyboard.press("k");
  await sleep(400);
  const inner = await page.evaluate(() => {
    const isl = document.querySelector("[data-testid=slot-edit-island]");
    const fc = isl?.querySelector(".cm-fat-cursor");
    return {
      color: fc ? getComputedStyle(fc).color : "no-fat-cursor",
      guard: !!isl?.querySelector(".cm-editor")?.className.includes("cm-wys-blank-fatcursor"),
    };
  });
  expect(inner.guard, "the caret-guard class reaches the island editor").toBe(true);
  expect(inner.color, "island fat cursor glyph is transparent (no hidden source char)").toBe("rgba(0, 0, 0, 0)");
});

test("#278-12 ④: tab right padding = ×-slot only when × renders; Reading is symmetric", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "layout-278-12c");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("::::tabs\n:::tab[Alpha]\na\n:::\n:::tab[Beta]\nb\n:::\n::::\n\nbot\n");
  await sleep(800);
  await page.getByText("bot", { exact: true }).click();
  await sleep(300);
  const tabSel = "[data-pane=preview] .cm-lp-tab";
  const edit = await page.locator(tabSel).first().evaluate((el) => ({
    hasX: !!el.querySelector(".cm-lp-tab-remove"),
    pl: parseFloat(getComputedStyle(el).paddingLeft),
    pr: parseFloat(getComputedStyle(el).paddingRight),
  }));
  expect(edit.hasX, "edit-surface tab renders its ×").toBe(true);
  expect(edit.pr, "edit-surface tab reserves the ×-slot on the right").toBeGreaterThan(edit.pl);
  await page.getByTestId("displaymode-reading").click({ force: true });
  await sleep(500);
  // Reading REUSES the edit-built DOM (the × span survives in the tree) — what must hold is that the
  // × is INVISIBLE (display:none, even on hover) and the ×-slot padding is gone (symmetric).
  const read = await page.locator(tabSel).first().evaluate((el) => ({
    xDisplayed: Array.from(el.querySelectorAll(".cm-lp-tab-remove")).some((x) => getComputedStyle(x).display !== "none"),
    pl: parseFloat(getComputedStyle(el).paddingLeft),
    pr: parseFloat(getComputedStyle(el).paddingRight),
  }));
  expect(read.xDisplayed, "Reading never displays the ×").toBe(false);
  expect(Math.abs(read.pr - read.pl), `Reading tab padding is symmetric (pl=${read.pl} pr=${read.pr})`).toBeLessThanOrEqual(0.5);
});

test("#278-12 ⑤: island enter→exit→re-enter round-trips; Escape COMMITS the pending edit", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "layout-278-12d");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(":::columns\n:::column\nalpha\n:::\n:::column\nbeta\n:::\n:::\n\ntail\n");
  await sleep(800);
  const island = page.locator("[data-testid=slot-edit-island]");
  // cycle 1: enter, EDIT, exit via normal-mode Escape → the edit must be COMMITTED (was discarded)
  await page.locator("[data-pane=preview]").getByText("alpha", { exact: true }).click();
  await sleep(700);
  await expect(island, "cycle 1: island mounts").toHaveCount(1);
  await island.locator(".cm-content").click();
  await page.keyboard.press("End");
  await page.keyboard.type("ZQX", { delay: 15 });
  await sleep(200);
  await page.keyboard.press("Escape");
  await sleep(700);
  await expect(island, "Escape exits the island").toHaveCount(0);
  await expect(page.locator("[data-pane=preview]").getByText("alphaZQX", { exact: true }), "the Escape exit committed the edit").toHaveCount(1);
  // cycle 2: re-enter the SAME slot ('s exact repro) — the island mounts again AND takes focus
  await page.locator("[data-pane=preview]").getByText("alphaZQX", { exact: true }).click();
  await sleep(700);
  await expect(island, "cycle 2: re-entry mounts the island again").toHaveCount(1);
  const focused = await page.evaluate(() => {
    const isl = document.querySelector("[data-testid=slot-edit-island]");
    return !!isl && isl.contains(document.activeElement);
  });
  expect(focused, "cycle 2: the re-entered island has focus").toBe(true);
  // cycle 3: exit by clicking top-level, then re-enter once more (the click-out path)
  await page.locator("[data-pane=preview]").getByText("tail", { exact: true }).click();
  await sleep(600);
  await expect(island, "click-out exits the island").toHaveCount(0);
  await page.locator("[data-pane=preview]").getByText("alphaZQX", { exact: true }).click();
  await sleep(700);
  await expect(island, "cycle 3: re-entry after click-out exit").toHaveCount(1);
});
