import { test, expect } from "@playwright/test";
import { openScratch, enterEdit, sleep } from "../helpers";

// #278(review rejection, 5 points) — the real-DOM pins the rejection requires.
//  1. REVEAL PURITY (the twice-rejected mixed state): while a typed callout is revealed (caret-in),
//     NO line carries the panel skin (cm-lp-callout*) — the raw `:::` source shows plain. The class
//     coexistence `cm-lp-callout` + `cm-lp-macro-raw` on one line is the forbidden state.
//  2. The tab × is a bordered chip the size of the column × (not a bare glyph).
//  3. vim `o` (and A→Enter) on the ISLAND's bottom line adds a line INSIDE the island — the outer
//     vim-atom capture handler must not swallow island keys (it rewrote the outer doc and killed
//     the island mid-keystroke).
//  4. The raw-entry pill (Ctrl+↵) is hover/caret-gated: hidden with the caret on a body line and the
//     mouse away; shown when the caret rests on the block's head line.
//  5. Nested corner controls (the ✎ on a selected nested macro) sit INSIDE the tab panel, not
//     floated above its top edge (where the container clipped them).

test("#278-5 point 1: a revealed callout shows plain source — no panel skin on any line", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "reveal-purity");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("intro\n\n:::warning[Careful]\nbody line\n:::\n\ntail\n");
  await sleep(600);
  // caret out → the panel renders (tinted, icon)
  await page.getByText("tail", { exact: true }).click();
  await sleep(300);
  await expect(page.locator("[data-pane=preview] .cm-lp-callout-panel")).toHaveCount(1);
  // caret IN (enter-to-edit) → plain raw source, zero panel-skin lines, zero mixed lines
  await page.getByText("body line").click();
  await sleep(400);
  const state = await page.evaluate(() => {
    const lines = [...document.querySelectorAll("[data-pane=preview] .cm-line")];
    return {
      skinned: lines.filter((l) => /cm-lp-callout/.test(l.className)).length,
      mixed: lines.filter((l) => /cm-lp-callout/.test(l.className) && /cm-lp-macro-raw/.test(l.className)).length,
      rawLead: lines.some((l) => /cm-lp-macro-raw(\s|$)/.test(l.className)),
      rawFence: lines.some((l) => (l.textContent ?? "").includes(":::warning[Careful]")),
    };
  });
  expect(state.mixed, "the forbidden panel-skin + raw coexistence").toBe(0);
  expect(state.skinned, "no panel skin at all while revealed").toBe(0);
  expect(state.rawLead, "the raw lead line (pill anchor) is present").toBe(true);
  expect(state.rawFence, "the raw fence text is visible").toBe(true);
});

test("#278-5 point 4: the raw pill is hover/caret-gated, not always-on", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "pill-gate");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("intro\n\n:::warning[Careful]\nbody line\n:::\n\ntail\n");
  await sleep(600);
  await page.getByText(/:::warning/).first().waitFor({ state: "hidden" }).catch(() => {});
  // enter the block, then put the caret on the BODY line with the mouse parked far away
  await page.getByText("body line").click();
  await sleep(300);
  await page.mouse.move(30, 30);
  await page.keyboard.press("ArrowDown"); // head line → body line (panel click can land on the head)
  await sleep(300);
  const pill = page.locator(".cm-lp-macro-richui-raw");
  await expect(pill, "pill exists while revealed").toHaveCount(1);
  const hidden = await pill.evaluate((el) => getComputedStyle(el).opacity);
  expect(parseFloat(hidden), "caret on a body line + mouse away → hidden").toBeLessThan(0.05);
  // caret on the HEAD line → visible (keyboard path)
  await page.keyboard.press("ArrowUp");
  await sleep(300);
  const onHead = await pill.evaluate((el) => getComputedStyle(el).opacity);
  expect(parseFloat(onHead), "caret on the head line → shown").toBeGreaterThan(0.5);
});

test("#278-5 points 2+5: tab × matches the column × chip; nested ✎ sits inside the panel", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "tabx-corner");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(
    "intro\n\n::::tabs\n:::tab[One]\n```mermaid\nflowchart TD\n  A-->B\n```\n:::\n:::tab[Two]\ntwo\n:::\n::::\n\n::::columns\n:::column\nL\n:::\n:::column\nR\n:::\n::::\n\ntail\n",
  );
  await sleep(900);
  await page.getByText("tail", { exact: true }).click();
  await sleep(400);
  // point 2: hover the tab and the column; the two × chips must match in size and box treatment
  await page.locator(".cm-lp-tab").first().hover();
  await sleep(250);
  const tabX = await page.locator(".cm-lp-tab-remove").first().evaluate((el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return { w: r.width, h: r.height, border: cs.borderTopWidth };
  });
  await page.locator("[data-pane=preview] .cm-lp-column").first().hover();
  await sleep(250);
  const colX = await page.locator(".cm-lp-layout-item-remove").first().evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { w: r.width, h: r.height };
  });
  expect(tabX.border, "tab × is a bordered chip like the column ×").toBe("1px");
  expect(Math.abs(tabX.w - colX.w), "tab × width matches the column ×").toBeLessThanOrEqual(2);
  expect(Math.abs(tabX.h - colX.h), "tab × height matches the column ×").toBeLessThanOrEqual(2);
  // point 5: select the nested mermaid — its corner ✎ must sit INSIDE the tab panel (not clipped above)
  await page.locator(".cm-lp-tabpanel-active [data-testid=macro-mermaid]").first().click();
  await sleep(400);
  const pos = await page.evaluate(() => {
    const pen = document.querySelector("[data-testid=nested-macro-edit]");
    const panel = document.querySelector(".cm-lp-tabpanel-active");
    if (!pen || !panel) return null;
    return { penTop: pen.getBoundingClientRect().top, panelTop: panel.getBoundingClientRect().top };
  });
  expect(pos, "pencil + active panel found").not.toBeNull();
  expect(pos!.penTop, "the ✎ starts inside the panel").toBeGreaterThanOrEqual(pos!.panelTop);
});

test("#278-5 point 3: vim o / A→Enter on the island's bottom line adds a line inside the island", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "island-vim-o");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  // the rejection shape: the island body ENDS with a callout (its raw→atom flip was the trigger)
  await page.keyboard.insertText("::::columns\n:::column\nlead\n\n:::warning[w]\ninner\n:::\n:::\n:::column\nR\n:::\n::::\n\ntail\n");
  await sleep(800);
  await page.getByText("tail", { exact: true }).click();
  await sleep(200);
  await page.getByTestId("vim-toggle").click();
  await sleep(300);
  // open the island on the left column
  await page.getByText("lead", { exact: true }).click();
  await sleep(700);
  const island = page.locator("[data-testid=slot-edit-island] .cm-content").first();
  await expect(island, "island open").toHaveCount(1);
  // vim: G to the bottom line, o opens a line INSIDE the island, type marker text
  await page.keyboard.type("G");
  await sleep(250);
  await page.keyboard.type("o");
  await sleep(300);
  await page.keyboard.type("NEWLINE1");
  await sleep(300);
  await expect(island, "island survived o").toHaveCount(1);
  await expect(island).toContainText("NEWLINE1");
  // A → Enter on the (new) bottom line appends another
  await page.keyboard.press("Escape"); // insert → normal (stays inside — the two-stage Escape)
  await sleep(200);
  await expect(island, "island survived the insert→normal Escape").toHaveCount(1);
  await page.keyboard.type("A");
  await sleep(200);
  await page.keyboard.press("Enter");
  await page.keyboard.type("NEWLINE2");
  await sleep(300);
  await expect(island, "island survived A+Enter").toHaveCount(1);
  await expect(island).toContainText("NEWLINE2");
  // commit lands in the outer doc
  await page.getByText("tail", { exact: true }).click();
  await sleep(600);
  await expect(page.locator("[data-pane=preview] .cm-content").first()).toContainText("NEWLINE1");
  await expect(page.locator("[data-pane=preview] .cm-content").first()).toContainText("NEWLINE2");
});
