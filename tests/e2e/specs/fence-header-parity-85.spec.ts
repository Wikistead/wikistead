import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openScratch, enterEdit, sleep, API } from "../helpers";

// #85 (review rejection, item ③ "the fence header looks different"): the filename tab is measured on BOTH
// surfaces in one run and compared, rather than trusted.
//
// The report said the export drew a 6px radius with 6px padding while the editor drew 3px and 3px, and
// asked for the export's values to be adopted by the editor. Measured here, the two surfaces already
// agree — same radius, same padding, same font size — which is why nothing was "back-ported": there was
// no difference to move. Reading the CSS said the same (both sides declare `6px 6px 0 0` and
// `0.1em 0.7em`), but a declaration is not a computed value, and the whole reason this ticket has burned
// five reviews is people comparing the wrong things.
//
// So the numbers become a pin. The failure this guards is real even though the reported one was not:
// the two surfaces are styled by two different mechanisms — a CodeMirror baseTheme object and a plain
// stylesheet — and nothing else compares them. A change to one is exactly the drift #381 named.
//
// What it deliberately does NOT compare: the WIDTH. The editor's column carries the gutter and the
// file's does not (measured 684 vs 704), so equal widths would be the wrong assertion — the header is
// full-width in both, which is what the shape actually promises.
const FIXTURE = ['```js title="app.js" showLineNumbers {2}', "const x = 1;", "const y = 2;", "```", "", "tail text", ""].join("\n");

const READ_TAB = `(() => {
  const el = document.querySelector(".cm-lp-code-tab");
  if (!el) return null;
  const c = getComputedStyle(el);
  const header = document.querySelector(".cm-lp-code-header");
  return {
    radius: c.borderTopLeftRadius, padTop: c.paddingTop, padLeft: c.paddingLeft,
    font: c.fontSize, background: c.backgroundColor, border: c.borderTopColor,
    headerFont: header ? getComputedStyle(header).fontSize : null,
  };
})()`;

test("#85: the fence header is the same object on the editing surface and in the saved file", async ({ page, browser }) => {
  test.setTimeout(240_000);
  const id = await openScratch(page, `hdr85-${Date.now()}`);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  // written through CM's dispatch: typing a fence info string trips auto-closing quotes (export-parity-85)
  await page.evaluate((text) => {
    const el = document.querySelector("[data-pane=preview] .cm-content") as { cmView?: { view?: unknown }; cmTile?: { view?: unknown } } | null;
    const view = (el?.cmView?.view ?? el?.cmTile?.view) as { state: { doc: { length: number } }; dispatch(t: unknown): void } | undefined;
    if (!view) throw new Error("no editor view to write the fixture into");
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
  }, FIXTURE);
  await sleep(1200);
  await page.evaluate(async ({ api, pageId }) => {
    await fetch(`${api}/pages/${pageId}/publish`, { method: "POST", headers: { Authorization: "Bearer dev-token" } });
  }, { api: API, pageId: id });
  await page.reload();
  await page.waitForSelector("[data-pane=preview] .cm-content");
  await sleep(1500);

  const inApp = (await page.evaluate(READ_TAB)) as Record<string, string> | null;
  expect(inApp, "the editing surface drew a filename tab to measure").not.toBeNull();

  await page.click("[data-testid=page-overflow-trigger]");
  const dl = page.waitForEvent("download");
  await page.getByTestId("export-page-html").click();
  const savedPath = join(mkdtempSync(join(tmpdir(), "wks-hdr85-")), "export.html");
  await (await dl).saveAs(savedPath);

  const ctx = await browser.newContext();
  const opened = await ctx.newPage();
  await opened.goto(`file://${savedPath}`);
  await sleep(400);
  const inFile = (await opened.evaluate(READ_TAB)) as Record<string, string> | null;
  await ctx.close();
  expect(inFile, "the saved file drew one too").not.toBeNull();

  // the comparison itself — read off both, never asserted against a literal
  expect(inFile, "the tab is the same object on both surfaces").toEqual(inApp);
});
