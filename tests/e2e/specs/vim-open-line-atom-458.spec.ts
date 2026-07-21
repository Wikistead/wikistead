import { test, expect, type Page } from "@playwright/test";
import { openScratch, enterEdit, sleep } from "../helpers";

// #458 acceptance list, pinned. The ticket reports vim `o` on the line just below a macro warping the
// caret to the atom's edge. Measured on this master it does not: every livePreview block ends at its
// last line's end, so a caret on the following line sits at `to + 1` and the o/O interception cannot
// see it as "on the atom". Rather than leave that as a one-off measurement, the behaviour the ticket
// asks for is locked in here — across macro kinds, both neighbours, and both arrival routes — so the
// reported symptom cannot appear silently later. The interception's own case (#183: `o`/`O` ON an
// atom opens outside it, never splitting the macro) is pinned alongside, because the tempting "fix"
// for the report — making the block bound exclusive — would break exactly that.

const readDoc = (p: Page) => p.evaluate(() => {
  const ed = document.querySelector("[data-pane=preview] .cm-editor") as { cmView?: { view?: unknown } } | null;
  const view = (ed?.cmView?.view ?? (document.querySelector("[data-pane=preview] .cm-content") as { cmTile?: { view?: unknown } } | null)?.cmTile?.view) as
    { state: { doc: { toString(): string } } };
  return view.state.doc.toString();
});

// Is the caret currently inside a live-preview ATOM? (reveal-on-cursor takes a macro out of the set,
// which decides whether the o/O interception can fire at all.)
const onAtom = (p: Page) => p.evaluate(() => {
  const ed = document.querySelector("[data-pane=preview] .cm-editor") as { cmView?: { view?: unknown } } | null;
  const view = (ed?.cmView?.view ?? (document.querySelector("[data-pane=preview] .cm-content") as { cmTile?: { view?: unknown } } | null)?.cmTile?.view) as
    { state: { selection: { main: { head: number } }; values: unknown[] } };
  const head = view.state.selection.main.head;
  let blocks: { from: number; to: number }[] = [];
  for (const v of view.state.values) {
    const b = (v as { blocks?: { from: number; to: number }[] } | null)?.blocks;
    if (Array.isArray(b)) blocks = blocks.concat(b);
  }
  return blocks.some((b) => head >= b.from && head <= b.to);
});

const MACROS: Record<string, string> = {
  children: ":::children\n:::",
  columns: ":::columns\n::column\nhi\n:::",
  warning: ":::warning\ncareful\n:::",
  mermaid: "```mermaid\ngraph TD\nA-->B\n```",
  table: "| a | b |\n| --- | --- |\n| 1 | 2 |",
};

async function vimPage(browser: import("@playwright/test").Browser, body: string, label: string) {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, `vim458-${label}-${Date.now()}`);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(body);
  await sleep(900);
  await page.getByText("lastline", { exact: true }).click(); // caret off the macro → it renders as an atom
  await sleep(300);
  await page.getByTestId("vim-toggle").click();
  await sleep(300);
  return page;
}

// The line below a macro: `o` must open the NEXT line down, not jump to the macro's edge.
for (const [name, src] of Object.entries(MACROS)) {
  test(`#458: o on the line below a ${name} opens the line under it, not at the atom's edge`, async ({ browser }) => {
    const page = await vimPage(browser, `top\n${src}\nbelowline\nlastline\n`, name);
    await page.getByText("belowline", { exact: true }).click();
    await sleep(250);
    await page.keyboard.press("Escape");
    await sleep(150);

    await page.keyboard.press("o");
    await sleep(250);
    await page.keyboard.insertText("XXMARK");
    await sleep(400);

    const lines = (await readDoc(page)).split("\n");
    const below = lines.indexOf("belowline");
    const mark = lines.findIndex((l) => l.includes("XXMARK"));
    expect(below, "the fixture line is present").toBeGreaterThan(0);
    expect(mark, `the new line opened directly below "belowline" (doc: ${JSON.stringify(lines)})`).toBe(below + 1);
  });
}

test("#458: O on the line above a macro opens above that line (it does not cross the macro)", async ({ browser }) => {
  const page = await vimPage(browser, "top\n:::warning\ncareful\n:::\nbelowline\nlastline\n", "above");
  await page.getByText("top", { exact: true }).click();
  await sleep(250);
  await page.keyboard.press("Escape");
  await sleep(150);

  await page.keyboard.press("O");
  await sleep(250);
  await page.keyboard.insertText("YYMARK");
  await sleep(400);

  const lines = (await readDoc(page)).split("\n");
  expect(lines[0], "the new line is above the line the caret was on").toContain("YYMARK");
  expect(lines[1]).toBe("top");
});

// #183 symptom B, the case the interception exists for — but only where it can apply. Measured on
// this master: with the caret ON it, a macro that reveals its source (warning / mermaid / table /
// embed / toc) drops out of livePreview.blocks, so the o/O interception cannot fire for it; only a
// macro that stays rendered under the caret (children) is still an atom. Both halves are pinned,
// because the difference is what makes "o near a macro" behave in two ways that look inconsistent.
test("#458 / #183: on a macro that stays an ATOM under the caret, o opens outside the whole macro", async ({ browser }) => {
  const page = await vimPage(browser, "top\n:::children\n:::\nbelowline\nlastline\n", "onatom");
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.press("Escape");
  await page.keyboard.type("gg");
  await sleep(200);
  await page.keyboard.press("j"); // one motion stop lands ON the atom (ADR-024)
  await sleep(300);
  expect(await onAtom(page), "the fixture premise: this macro is still an atom under the caret").toBe(true);

  await page.keyboard.press("o");
  await sleep(250);
  await page.keyboard.insertText("ZZMARK");
  await sleep(400);

  const lines = (await readDoc(page)).split("\n");
  const open = lines.findIndex((l) => l.startsWith(":::children"));
  const close = lines.findIndex((l, i) => i > open && l.trim() === ":::");
  const mark = lines.findIndex((l) => l.includes("ZZMARK"));
  expect(open, "the macro survived intact").toBeGreaterThan(-1);
  expect(close, "…including its closing fence").toBeGreaterThan(open);
  expect(mark, `the new line is outside the macro (doc: ${JSON.stringify(lines)})`).toBeGreaterThan(close);
});

test("#458: on a macro REVEALED under the caret, o edits its source and leaves the macro well-formed", async ({ browser }) => {
  const page = await vimPage(browser, "top\n:::warning\ncareful\n:::\nbelowline\nlastline\n", "revealed");
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.press("Escape");
  await page.keyboard.type("gg");
  await sleep(200);
  await page.keyboard.press("j");
  await sleep(300);
  expect(await onAtom(page), "the fixture premise: reveal-on-cursor took it out of the atom set").toBe(false);

  await page.keyboard.press("o");
  await sleep(250);
  await page.keyboard.insertText("WWMARK");
  await sleep(400);

  const lines = (await readDoc(page)).split("\n");
  const open = lines.findIndex((l) => l.startsWith(":::warning"));
  const close = lines.findIndex((l, i) => i > open && l.trim() === ":::");
  expect(open, "the opening fence is intact").toBeGreaterThan(-1);
  expect(close, "the closing fence is intact — the macro was not split").toBeGreaterThan(open);
  const mark = lines.findIndex((l) => l.includes("WWMARK"));
  expect(mark, `the new line landed in the revealed source, between the fences (doc: ${JSON.stringify(lines)})`).toBeGreaterThan(open);
  expect(mark).toBeLessThan(close);

  // and moving the caret away renders it again — the edit did not break the macro
  await page.keyboard.press("Escape");
  await page.getByText("lastline", { exact: true }).click();
  await sleep(500);
  await expect(page.locator("[data-pane=preview] [data-testid=callout-panel]").first(), "it renders as a callout again").toBeVisible({ timeout: 8000 });
});

// Adjacent macros with no blank line between them: the line under the CLUSTER must behave the same.
test("#458: o below a cluster of adjacent macros opens under the cursor line", async ({ browser }) => {
  const body = "top\n:::children\n:::\n:::warning\ncareful\n:::\nbelowline\nlastline\n";
  const page = await vimPage(browser, body, "cluster");
  await page.getByText("belowline", { exact: true }).click();
  await sleep(250);
  await page.keyboard.press("Escape");
  await sleep(150);

  await page.keyboard.press("o");
  await sleep(250);
  await page.keyboard.insertText("CCMARK");
  await sleep(400);

  const lines = (await readDoc(page)).split("\n");
  const below = lines.indexOf("belowline");
  expect(lines[below + 1], `doc: ${JSON.stringify(lines)}`).toContain("CCMARK");
});

// A BLANK line under the macro is the shape the report describes most directly.
test("#458: o on a blank line under a macro opens a further line down", async ({ browser }) => {
  const page = await vimPage(browser, "top\n:::children\n:::\n\nlastline\n", "blank");
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.press("Escape");
  await page.keyboard.type("gg");
  await sleep(200);
  await page.keyboard.press("j"); // onto the atom
  await sleep(250);
  await page.keyboard.press("j"); // onto the blank line under it
  await sleep(250);
  const lineBefore = await page.evaluate(() => (window as { __lpHeadLine?: number }).__lpHeadLine ?? -1);

  await page.keyboard.press("o");
  await sleep(250);
  const lineAfter = await page.evaluate(() => (window as { __lpHeadLine?: number }).__lpHeadLine ?? -1);
  expect(lineAfter, "the caret moved DOWN one line — it did not warp back up to the macro").toBe(lineBefore + 1);
});
