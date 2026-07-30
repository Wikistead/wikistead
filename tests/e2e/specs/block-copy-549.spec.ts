import { test, expect } from "@playwright/test";
import { openScratch, enterEdit, sleep } from "../helpers";

// #549: without vim there was NO way to take a block macro's full Markdown source. Ctrl+C on a parked
// atom (atomClipboard, #359) exists but Live-mode reveal makes the parked state mouse-unreachable; the
// fence header's copy button takes the CONTENT only. The fix: a right-click "Copy block" entry that
// resolves the innermost macro at the click (rendered or revealed, any depth) and copies its canonical
// source — fence/::: markers included (Open formats). Read-only: the doc must not change by one byte.
// Real Chromium (clipboard + CM tooltip layer).

const FENCE = "```mermaid\ngraph TD; A-->B;\n```";
const NOTE = ":::note\nAAA note\n:::";

test("#549: right-click Copy block takes the whole fence source; the doc is untouched", async ({ browser }) => {
  const ctx = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  const page = await ctx.newPage();
  await openScratch(page, `bc549-${Date.now().toString(36)}`);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content >> nth=0");
  await page.keyboard.insertText(`top\n\n${FENCE}\n\nbot\n`);
  await sleep(1200);
  const before = await page.locator("[data-pane=preview] .cm-content").innerText();

  await page.locator("[data-testid=macro-mermaid]").first().click({ button: "right" });
  await sleep(300);
  const entry = page.getByTestId("ctx-item-copyblock");
  await expect(entry, "the Copy block entry appears on a macro block").toBeVisible();
  await entry.dispatchEvent("mousedown"); // the menu acts on mousedown (see context-menu.ts item())
  await sleep(300);
  expect(await page.evaluate(() => navigator.clipboard.readText()), "canonical source incl. the fence markers").toBe(FENCE);
  expect(await page.locator("[data-pane=preview] .cm-content").innerText(), "copy is read-only").toBe(before);
});

test("#549: on a NESTED macro the innermost block is copied — not the whole container", async ({ browser }) => {
  const ctx = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  const page = await ctx.newPage();
  await openScratch(page, `bc549n-${Date.now().toString(36)}`);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content >> nth=0");
  await page.keyboard.insertText(`top\n\n::::columns\n:::column\n${NOTE}\n:::\n:::column\nBBB text\n:::\n::::\n\nbot\n`);
  await sleep(1200);
  await page.getByText("bot").click(); // caret away → the container renders as a widget
  await sleep(300);

  await page.getByText("AAA note").click({ button: "right" });
  await sleep(300);
  const entry = page.getByTestId("ctx-item-copyblock");
  await expect(entry).toBeVisible();
  await entry.dispatchEvent("mousedown");
  await sleep(300);
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip, "the innermost note, fences included").toBe(NOTE);
  expect(clip, "NOT the container").not.toContain("columns");
});

test("#549: non-vim Ctrl+C on a clicked nested macro copies the whole block source (atomClipboard in the island)", async ({ browser }) => {
  const ctx = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  const page = await ctx.newPage();
  await openScratch(page, `bc549k-${Date.now().toString(36)}`);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content >> nth=0");
  await page.keyboard.insertText(`top

::::columns
:::column
${NOTE}
:::
:::column
BBB text
:::
::::

bot
`);
  await sleep(1200);
  await page.getByText("bot").click();
  await sleep(300);
  await page.getByText("AAA note").click(); // enters the slot island; the note is the selected atom inside it
  await sleep(500);
  await page.keyboard.press("Control+c");
  await sleep(300);
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip, "the whole nested block, fences included").toBe(NOTE);
});

// ---------------------------------------------------------------------------------------------
// #549 review the pins below use the MOUSE gesture — click the rendered block, then
// Ctrl+C — because the first round pinned keyboard-parked carets and shipped a fix that failed on
// the device for every mouse path. Three distinct failure modes were measured and each is closed:
//   - the copy event's DOM target lands inside widget DOM (or on document.body), where CM's
//     eventBelongsToEditor drops it → NOTHING was copied (excalidraw / island cases);
//   - a Live-mode widget click REVEALS the block and lands the caret on its marker line → CM's
//     line-copy default emitted the bare "```mermaid" fragment (#359's symptom, back);
//   - some widgets (details bar, container chrome) never park the caret on the block → Ctrl+C
//     copied whatever unrelated line held the caret.

const EXCALIDRAW = '```excalidraw\n{ "type": "excalidraw", "version": 2, "elements": [], "appState": {} }\n```';
const DETAILS = ":::details[Summary]\nDDD hidden body\n:::";
const TABS = "::::tabs\n:::tab[One]\n```mermaid\ngraph TD; X-->Y;\n```\n:::\n:::tab[Two]\nTTT text\n:::\n::::";

async function mouseCopyPage(browser: import("@playwright/test").Browser, tag: string, source: string) {
  const ctx = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  const page = await ctx.newPage();
  await openScratch(page, `bc549m-${tag}-${Date.now().toString(36)}`);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content >> nth=0");
  await page.keyboard.insertText(`# heading top\n\n${source}\n\nbot\n`);
  await sleep(1500);
  await page.getByText("bot").click(); // caret away → the block renders as a widget
  await sleep(400);
  await page.evaluate(() => navigator.clipboard.writeText("SENTINEL")); // a stale-clipboard read must fail loudly
  return page;
}
const readClip = (page: import("@playwright/test").Page) => page.evaluate(() => navigator.clipboard.readText());

for (const [tag, source, locate] of [
  ["mermaid fence", FENCE, (p: import("@playwright/test").Page) => p.locator("[data-pane=preview] [data-testid=macro-mermaid]").first()],
  ["excalidraw fence (parked atom)", EXCALIDRAW, (p: import("@playwright/test").Page) => p.locator("[data-pane=preview] [data-testid=macro-excalidraw]").first()],
  [":::note directive", NOTE, (p: import("@playwright/test").Page) => p.locator("[data-pane=preview] [data-testid=callout-panel]").first()],
  [":::details", DETAILS, (p: import("@playwright/test").Page) => p.locator("[data-pane=preview] .cm-lp-details-collapsible").first()],
] as const) {
  test(`#549 MOUSE click on a ${tag} → Ctrl+C takes the whole source`, async ({ browser }) => {
    const page = await mouseCopyPage(browser, tag.split(" ")[0]!, source);
    await locate(page).click();
    await sleep(500);
    await page.keyboard.press("Control+c");
    await sleep(400);
    expect(await readClip(page), "canonical source, markers included").toBe(source);
  });
}

test("#549 the bare ```mermaid fragment can NEVER be what a block click copies", async ({ browser }) => {
  // The #359 symptom, pinned on its own: whatever else changes, a widget click followed by Ctrl+C
  // must not yield a single marker line (silently-wrong is worse than nothing).
  const page = await mouseCopyPage(browser, "frag", FENCE);
  await page.locator("[data-pane=preview] [data-testid=macro-mermaid]").first().click();
  await sleep(500);
  await page.keyboard.press("Control+c");
  await sleep(400);
  const clip = await readClip(page);
  expect(clip.trim(), "not a broken one-line fragment").not.toBe("```mermaid");
  expect(clip, "and not the untouched sentinel either").not.toBe("SENTINEL");
});

test("#549 KEYBOARD onto the marker line (arrow into the block) → Ctrl+C still takes the whole source", async ({ browser }) => {
  // The last-clicked-widget record dies on any non-copy keydown, so arrowing onto a revealed
  // block's "```mermaid" line exercises the marker-line rule ALONE — without it this copies the
  // bare fragment (#359's symptom through the keyboard door).
  const page = await mouseCopyPage(browser, "kbd", FENCE);
  await page.locator("[data-pane=preview] .cm-content").getByText("heading top").click(); // the `# ` marker is hidden in Live; scope past the ToC entry
  await sleep(300);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown"); // blockEntry steers the caret INTO the atom → it reveals, caret on the opening marker line
  await sleep(400);
  await page.keyboard.press("Control+c");
  await sleep(400);
  expect(await readClip(page), "whole source, not the marker line").toBe(FENCE);
});

test("#549 tabs PANEL click enters the slot (#278) — Ctrl+C takes the INNERMOST block the ring shows", async ({ browser }) => {
  const page = await mouseCopyPage(browser, "tabsp", TABS);
  await page.locator("[data-pane=preview] .cm-lp-tabs, [data-pane=preview] [data-testid=macro-tabs]").first().click();
  await sleep(500);
  await page.keyboard.press("Control+c");
  await sleep(400);
  expect(await readClip(page), "the inner fence, not the container (innermost-wins, #215)").toBe("```mermaid\ngraph TD; X-->Y;\n```");
});

test("#549 tabs CHROME click (no slot entry) — Ctrl+C takes the whole container", async ({ browser }) => {
  const page = await mouseCopyPage(browser, "tabsc", TABS);
  const bb = (await page.locator("[data-pane=preview] .cm-lp-macro-wrap").first().boundingBox())!;
  await page.mouse.click(bb.x + bb.width - 6, bb.y + 4); // the wrap's top-right border strip — chrome, not a slot/tab button
  await sleep(500);
  await page.keyboard.press("Control+c");
  await sleep(400);
  expect(await readClip(page), "container source in full").toBe(TABS);
});

test("#549 normal editing is untouched — Ctrl+C on a revealed CONTENT line copies that line only", async ({ browser }) => {
  // Guard against the rules overreaching: once the writer clicks INTO revealed raw source (a
  // content line, not the widget), the empty-caret copy keeps CM's line default.
  const page = await mouseCopyPage(browser, "edit", FENCE);
  await page.locator("[data-pane=preview] [data-testid=macro-mermaid]").first().click(); // reveals
  await sleep(400);
  await page.getByText("graph TD; A-->B;").click(); // now a raw text line — a caret placement, not a widget click
  await sleep(300);
  await page.keyboard.press("Control+c");
  await sleep(400);
  expect(await readClip(page), "CM's copy-the-line default").toBe("graph TD; A-->B;");
});

// The fence header's own CONTENT-copy button is deliberately untouched by #549 (different job);
// its pin lives in public-page.spec.ts (`.cm-lp-code-copy` on the public surface).
