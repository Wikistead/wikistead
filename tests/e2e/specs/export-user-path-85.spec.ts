import { test, expect, type Page } from "@playwright/test";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { openScratch, enterEdit, sleep, API } from "../helpers";

// #85 (user ruling): acceptance is defined on the ONE path the user actually walks —
// "⋯ → Export as HTML → open the downloaded file with the app closed → it looks like the editor".
// Four reviews burned on gates that inspected the document the app ASSEMBLED while nobody ever
// OPENED the file it SAVED (blank on screen; blank again, from the fix for the previous
// blank). So this spec drives the real download, then leaves the app entirely: the saved bytes are
// opened from file:// in a fresh browser context, where the only stylesheet is the one that travelled.
//
// Every assertion here runs against that opened file (or compares it to the live app), never against
// an in-app iframe or an HTML string:
//   1. the root has real dimensions, the text is VISIBLE, and a screenshot contains pixels that are
//      not the background — the defect (root 0×0, display:none) goes red on all three;
//   2. side-by-side parity (heading/body/callout/table/fence computed styles) read off the OPENED file;
//   3. diagrams (mermaid / excalidraw / plantuml) are figures inside the saved bytes — blob: count 0;
//   4. the same opened file survives print media (the marker round-trip warned about: fixing
//      "blank when printed" must not restore "blank on screen", and vice versa — both media pinned);
//   5. tabs all panes / details open / fence chrome / no chrome buttons, all asserted as VISIBILITY in
//      the opened file, not as substrings of a string nobody rendered.

const EXCALIDRAW_SCENE = JSON.stringify({
  type: "excalidraw",
  version: 2,
  elements: [{
    id: "r1", type: "rectangle", x: 0, y: 0, width: 120, height: 80, angle: 0,
    strokeColor: "#1e1e1e", backgroundColor: "#a5d8ff", fillStyle: "solid", strokeWidth: 2,
    strokeStyle: "solid", roughness: 1, opacity: 100, groupIds: [], frameId: null, roundness: null,
    seed: 1, version: 1, versionNonce: 1, isDeleted: false, boundElements: null, updated: 1,
    link: null, locked: false,
  }],
  appState: {},
  files: {},
});

const FIXTURE = [
  "# Heading one",
  "",
  "ordinary body text",
  "",
  "::::tabs",
  ":::tab[Alpha]",
  "alpha pane text",
  ":::",
  ":::tab[Beta]",
  "beta pane text",
  ":::",
  "::::",
  "",
  ":::details[Folded]",
  "folded body text",
  ":::",
  "",
  ":::note[Label]",
  "callout body",
  ":::",
  "",
  "| H1 | H2 |",
  "| --- | --- |",
  "| a | b |",
  "",
  '```js title="app.js" showLineNumbers {2}',
  "const x = 1;",
  "const y = 2;",
  "```",
  "",
  "```mermaid",
  "graph TD; A-->B;",
  "```",
  "",
  "```plantuml",
  "@startuml",
  "A -> B",
  "@enduml",
  "```",
  "",
  "```excalidraw",
  EXCALIDRAW_SCENE,
  "```",
  "",
].join("\n");

// The e2e stack runs no plantuml service; answering the render route is what lets the gate REQUIRE a
// picture in the file. A real 1×1 PNG so naturalWidth is non-zero when the file is opened.
const PLANTUML_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

// Minimal PNG reader (truecolor / truecolor+alpha, 8-bit, non-interlaced — what page.screenshot()
// produces), dependency-free on purpose. Returns unfiltered RGB(A) scanlines so pixels can be COUNTED:
// "the screenshot is not blank" must be a number, not an impression (§1).
function decodePng(buf: Buffer): { width: number; height: number; bpp: number; pixels: Buffer } {
  let pos = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat: Buffer[] = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9]; interlace = data[12];
    } else if (type === "IDAT") idat.push(data);
    pos += 12 + len;
  }
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6) || interlace !== 0)
    throw new Error(`unexpected PNG shape: depth=${bitDepth} colour=${colorType} interlace=${interlace}`);
  const bpp = colorType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const out = Buffer.alloc(width * height * bpp);
  let rp = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[rp]; rp += 1;
    for (let x = 0; x < stride; x++) {
      const cur = raw[rp + x];
      const left = x >= bpp ? out[y * stride + x - bpp] : 0;
      const up = y > 0 ? out[(y - 1) * stride + x] : 0;
      const ul = y > 0 && x >= bpp ? out[(y - 1) * stride + x - bpp] : 0;
      let val: number;
      switch (filter) {
        case 0: val = cur; break;
        case 1: val = cur + left; break;
        case 2: val = cur + up; break;
        case 3: val = cur + ((left + up) >> 1); break;
        case 4: {
          const p = left + up - ul;
          const pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - ul);
          val = cur + (pa <= pb && pa <= pc ? left : pb <= pc ? up : ul);
          break;
        }
        default: throw new Error(`PNG filter ${filter}`);
      }
      out[y * stride + x] = val & 0xff;
    }
    rp += stride;
  }
  return { width, height, bpp, pixels: out };
}

function countForegroundPixels(png: Buffer): { total: number; foreground: number } {
  const { width, height, bpp, pixels } = decodePng(png);
  const r0 = pixels[0], g0 = pixels[1], b0 = pixels[2]; // top-left = the sheet's background
  let foreground = 0;
  for (let i = 0; i < width * height; i++) {
    const o = i * bpp;
    if (Math.abs(pixels[o] - r0) + Math.abs(pixels[o + 1] - g0) + Math.abs(pixels[o + 2] - b0) > 30) foreground += 1;
  }
  return { total: width * height, foreground };
}

// The same computed-style probes the in-app parity spec uses — but read off the OPENED FILE.
const PROBES: { name: string; selector: string; props: string[] }[] = [
  { name: "heading", selector: "h1, .cm-lp-h1", props: ["color", "fontFamily", "fontWeight"] },
  { name: "body text", selector: "p", props: ["fontFamily", "fontSize", "lineHeight"] },
  { name: "callout box", selector: "[class*=cm-lp-callout]", props: ["backgroundColor", "borderLeftColor", "borderLeftWidth"] },
  { name: "table cell", selector: "td", props: ["borderTopColor", "borderTopWidth", "padding"] },
];
type Probe = Record<string, Record<string, string> | null>;
const readProbes = (root: Element, probes: typeof PROBES): Probe => {
  const out: Probe = {};
  for (const p of probes) {
    const el = root.querySelector(p.selector);
    if (!el) { out[p.name] = null; continue }
    const cs = getComputedStyle(el);
    const vals: Record<string, string> = {};
    for (const prop of p.props) vals[prop] = cs[prop as keyof CSSStyleDeclaration] as string;
    out[p.name] = vals;
  }
  return out;
};

async function authorAndPublish(page: Page): Promise<void> {
  const id = await openScratch(page, `export85-${Date.now()}`);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  // Written through CM's own dispatch — typing the fence info string trips auto-closing quotes/braces
  // and the doc stops being the fixture (the export-parity-85 lesson).
  await page.evaluate((text) => {
    const el = document.querySelector("[data-pane=preview] .cm-content") as { cmView?: { view?: unknown }; cmTile?: { view?: unknown } } | null;
    const view = (el?.cmView?.view ?? el?.cmTile?.view) as { state: { doc: { length: number } }; dispatch(t: unknown): void } | undefined;
    if (!view) throw new Error("no editor view to write the fixture into");
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
  }, FIXTURE);
  await sleep(1500);
  await page.evaluate(async ({ api, pageId }) => {
    await fetch(`${api}/pages/${pageId}/publish`, { method: "POST", headers: { Authorization: "Bearer dev-token" } });
  }, { api: API, pageId: id });
  await page.reload();
  await page.waitForSelector("[data-pane=preview] .cm-content");
  await sleep(1500);
}

test("#85 the downloaded file, opened with the app closed, IS the document", async ({ page, browser }) => {
  test.setTimeout(240_000);
  await page.route("**/plantuml/render", (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: PLANTUML_PNG }));
  await authorAndPublish(page);

  // ---- the user's export: ⋯ → Export as HTML → a real download ----
  await page.click("[data-testid=page-overflow-trigger]");
  const dl = page.waitForEvent("download");
  await page.getByTestId("export-page-html").click();
  const download = await dl;
  const dir = mkdtempSync(join(tmpdir(), "wks-export-85-"));
  const savedPath = join(dir, "export-85.html");
  await download.saveAs(savedPath);

  // ---- the saved BYTES: figures travel as data, nothing points back into the dead session ----
  const bytes = readFileSync(savedPath, "utf8");
  expect(bytes.length, "a non-trivial document was saved").toBeGreaterThan(10_000);
  expect(bytes, "no image points at a blob: handle that died with the session").not.toContain('src="blob:');
  expect(bytes, "the plantuml figure is baked in as bytes").toContain("data:image/png");
  expect(bytes, "no live script travels in the file").not.toContain("<script");
  // `data-print-root` carries the app's "hidden on screen" contract; the exported document's own
  // root must not wear it (it is identified by its export marker instead).
  expect(bytes, "the root does not wear the app's print-portal marker").not.toMatch(/<main[^>]*data-print-root/);

  // ---- open the saved file from file:// in a FRESH context: no app, no dev server, just the bytes ----
  const ctx = await browser.newContext();
  const opened = await ctx.newPage();
  await opened.goto(`file://${savedPath}`);
  await sleep(500);

  // 1a. the root is really there: computed display + real dimensions (measured 0×0, display:none)
  const root = opened.locator("main.wks-export-doc");
  const display = await root.evaluate((el) => getComputedStyle(el).display);
  expect(display, "the opened file's root is not display:none").not.toBe("none");
  const box = await root.boundingBox();
  expect(box, "the root has a box at all").not.toBeNull();
  expect(box!.width, "…with real width").toBeGreaterThan(100);
  expect(box!.height, "…and real height").toBeGreaterThan(100);

  // 1b. the text is VISIBLE — Playwright visibility is layout-backed, not textContent-backed
  await expect(opened.getByText("ordinary body text"), "body text is visible").toBeVisible();
  await expect(opened.getByRole("heading", { name: "Heading one" }), "the heading is visible").toBeVisible();

  // 1c. the pixels: a screenshot of the opened file contains foreground. Counted, not eyeballed.
  const shot = await opened.screenshot();
  const { total, foreground } = countForegroundPixels(shot);
  expect(foreground, `foreground pixels in the opened file (of ${total})`).toBeGreaterThan(5_000);

  // 5. the content pins, as VISIBILITY in the opened file: tabs (all panes), details (open), fence
  // chrome, callout, table, columns — and no app chrome travelled along.
  await expect(opened.getByText("alpha pane text"), "the pane the reader saw").toBeVisible();
  await expect(opened.getByText("beta pane text"), "…and the one they did not").toBeVisible();
  await expect(opened.getByText("folded body text"), "the disclosure body is readable").toBeVisible();
  expect(await opened.locator("details[open]").count(), "…because it travels open").toBeGreaterThan(0);
  await expect(opened.getByText("callout body"), "the callout body").toBeVisible();
  await expect(opened.getByText("app.js"), "the fence's file-name tab").toBeVisible();
  expect(await opened.locator(".cm-lp-code-numbered").count(), "line numbers").toBeGreaterThan(0);
  expect(await opened.locator(".cm-lp-code-hl").count(), "the highlighted line's band").toBeGreaterThan(0);
  await expect(opened.getByText("callout body")).toBeVisible();
  expect(await opened.locator("button").count(), "no app chrome (buttons) travelled").toBe(0);

  // 3. the diagrams are figures IN THE OPENED FILE, with real dimensions
  const mermaidBox = await opened.locator(".cm-lp-mermaid svg, [data-testid=macro-mermaid] svg").first().boundingBox();
  expect(mermaidBox, "mermaid drew as an inline svg").not.toBeNull();
  expect(mermaidBox!.width, "…with real width").toBeGreaterThan(10);
  const plantuml = opened.locator('img[src^="data:image/png"]').first();
  expect(await plantuml.count(), "the plantuml figure is an image in the file").toBeGreaterThan(0);
  expect(await plantuml.evaluate((el) => (el as HTMLImageElement).naturalWidth), "…that decodes").toBeGreaterThan(0);
  const excaliBox = await opened.locator("[data-testid=macro-excalidraw] svg").first().boundingBox();
  expect(excaliBox, "the excalidraw drawing drew as an inline svg").not.toBeNull();
  expect(excaliBox!.width, "…with real width").toBeGreaterThan(10);

  // 2. parity: the same computed properties, read off the app and off the OPENED FILE
  const appProbes = (await page.evaluate(
    ({ fn, probes }) => (new Function("return " + fn)())(document.querySelector("[data-pane=preview]") ?? document.body, probes),
    { fn: readProbes.toString(), probes: PROBES },
  )) as Probe;
  const fileProbes = (await opened.evaluate(
    ({ fn, probes }) => (new Function("return " + fn)())(document.body, probes),
    { fn: readProbes.toString(), probes: PROBES },
  )) as Probe;
  for (const probe of PROBES) {
    expect(appProbes[probe.name], `${probe.name}: missing on the app surface (fixture/selector problem, not the export)`).not.toBeNull();
    expect(fileProbes[probe.name], `${probe.name}: missing from the opened file`).not.toBeNull();
    expect(fileProbes[probe.name], `${probe.name}: the opened file does not match the screen`).toEqual(appProbes[probe.name]);
  }

  // 4. the SAME opened file under print media: fixing "blank on screen" must not bring back "blank in
  // print" (the marker round-trip called out). Root visible in BOTH media, pinned side by side.
  await opened.emulateMedia({ media: "print" });
  const printDisplay = await root.evaluate((el) => getComputedStyle(el).display);
  expect(printDisplay, "the opened file's root is visible under print media too").not.toBe("none");
  const printBox = await root.boundingBox();
  expect(printBox, "…and has a box in print").not.toBeNull();
  expect(printBox!.height, "…with real height in print").toBeGreaterThan(100);
  await opened.emulateMedia({ media: null });

  await ctx.close();
});
