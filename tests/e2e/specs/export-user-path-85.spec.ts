import { test, expect, type Page } from "@playwright/test";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { openScratch, enterEdit, sleep, API } from "../helpers";

// #85(user ruling): acceptance is defined on the ONE path the user actually walks
// "⋯ → Export as HTML → open the downloaded file with the app closed → it looks like the editor".
// Four reviews burned on gates that inspected the document the app ASSEMBLED while nobody ever
// OPENED the file it SAVED (blank on screen;blank again, from the fix for the previous
// blank). So this spec drives the real download, then leaves the app entirely: the saved bytes are
// opened from file:// in a fresh browser context, where the only stylesheet is the one that travelled.
//
// Every assertion here runs against that opened file (or compares it to the live app), never against
// an in-app iframe or an HTML string
// 1. the root has real dimensions, the text is VISIBLE, and a screenshot contains pixels that are
// not the background — thedefect (root 0×0, display:none) goes red on all three;
// 2. side-by-side parity (heading/body/callout/table/fence computed styles) read off the OPENED file;
// 3. diagrams (mermaid / excalidraw / plantuml) are figures inside the saved bytes — blob: count 0;
// 4. the same opened file survives print media (the marker round-tripwarned about: fixing
// "blank when printed" must not restore "blank on screen", and vice versa — both media pinned);
// 5. tabs all panes / details open / fence chrome / no chrome buttons, all asserted as VISIBILITY in
// the opened file, not as substrings of a string nobody rendered.

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
  // #85 (review rejection 2026-08-05): the callout icon did not travel. EVERY type is here, because the icon
  // is a per-type CSS variable and fixing one says nothing about the other four.
  ":::info[Info]", "info body", ":::", "",
  ":::tip[Tip]", "tip body", ":::", "",
  ":::warning[Warning]", "warning body", ":::", "",
  ":::danger[Danger]", "danger body", ":::", "",
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

// Minimal PNG reader (truecolor / truecolor+alpha, 8-bit, non-interlaced — what page.screenshot
// produces), dependency-free on purpose. Returns unfiltered RGB(A) scanlines so pixels can be COUNTED
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

test("#85the downloaded file, opened with the app closed, IS the document", async ({ page, browser }) => {
  test.setTimeout(240_000);
  await page.route("**/plantuml/render", (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: PLANTUML_PNG }));
  // #85 (review rejection, 2026-08-05): the reader whose file did not match their screen was reading in
  // JAPANESE, and that is the whole of the defect — `:root:lang(en)` (#190) makes an ENGLISH body
  // monospaced on purpose, so an English fixture agrees with a hard-coded `lang="en"` and measures
  // nothing. The app's own switch is used (localStorage, read at boot by i18n/index.ts) rather than a
  // stub, so what is exported is a page the product really produces.
  await page.addInitScript(() => { try { localStorage.setItem("wks.lang", "ja"); } catch { /* private mode */ } });
  await authorAndPublish(page);
  expect(await page.evaluate(() => document.documentElement.lang), "the app is in Japanese for this run").toBe("ja");

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
  //`data-print-root` carries the app's "hidden on screen" contract; the exported document's own
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
  // #579whole name, not a prefix — "Heading one" would also match a "Heading one and a half"
  // the fixture might grow, and this assertion is about the document rendering, not about matching.
  await expect(opened.getByRole("heading", { name: "Heading one", exact: true }), "the heading is visible").toBeVisible();

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

  // 1d. #85 (review rejection, 2026-08-05): the BODY FACE — measured before the generic parity loop so a
  // face mismatch is named as one rather than surfacing as whichever probe happens to be checked first. The parity probes above read computed values off
  // matching elements, and `font-family` matched because both sides resolved to a stack — while the FACE
  // actually painting the glyphs differed: the file announced `lang="en"`, `:root:lang(en)` (#190) swapped
  // `--font-body` to the code face, and A2 had just embedded that face, so the saved document drew the body
  // in Wikistead Mono. Measured then: 152px on screen, 170px in the file for the same string.
  //
  // Measured as WIDTH, not as a name: a stack is a preference list and the interesting question is which
  // face won. Canvas with the element's own resolved stack answers that, and the two numbers come from the
  // two documents — nothing here enumerates a font.
  //
  // The element it measures is found by its TEXT, not by a selector. Asking for the first `p` picked the
  // paragraph inside the mermaid diagram on both sides — which agree because mermaid sets its own font, so
  // the check read 165.4 vs 165.4 and proved nothing (measured, 2026-08-05). A figure is not the body.
  const RULER = "あいうえおABCabc123";
  const BODY_MARK = "ordinary body text";
  const measure = (ctxPage: typeof page, root: string) => ctxPage.evaluate(({ root, text, mark }) => {
    const scope = document.querySelector(root) ?? document.body;
    const el = [...scope.querySelectorAll<HTMLElement>("p, .cm-line")]
      .find((e) => (e.textContent || "").includes(mark));
    if (!el) return null;
    const cs = getComputedStyle(el);
    const c = document.createElement("canvas").getContext("2d")!;
    c.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    return { width: Math.round(c.measureText(text).width), family: cs.fontFamily, lang: document.documentElement.lang, tag: el.tagName };
  }, { root, text: RULER, mark: BODY_MARK });

  const appBody = await measure(page, "[data-pane=preview]");
  const fileBody = await measure(opened as unknown as typeof page, "main.wks-export-doc");
  expect(appBody, "the app surface has a paragraph to measure").not.toBeNull();
  expect(fileBody, "the opened file has a paragraph to measure").not.toBeNull();
  expect(fileBody!.lang, "the saved document speaks the page's language, not a literal").toBe(appBody!.lang);
  expect(fileBody!.width, `body face differs: screen ${appBody!.width}px (${appBody!.family}) vs file ${fileBody!.width}px (${fileBody!.family})`)
    .toBe(appBody!.width);

  // 1e. the callout icons ARRIVED and are DRAWN. The screen showed a warning triangle and the saved file
  // showed a filled block in the same place: the icon is a CSS mask whose value is a `data:image/svg+xml`
  // URL, and the export's CSS sanitizer drops that scheme on purpose (ADR-194 addendum A). The drawing
  // travels as an element instead, so the security line is untouched.
  //
  // Discovery, not a list of five: every icon holder the file contains is required to carry a drawing and
  // to paint ink. A sixth callout type tomorrow is covered by existing here.
  const icons = await opened.evaluate(() => [...document.querySelectorAll<HTMLElement>("[data-icon]")].map((el) => {
    const svg = el.querySelector("svg");
    const r = el.getBoundingClientRect();
    return {
      icon: el.getAttribute("data-icon"),
      shapes: svg ? svg.querySelectorAll("path,circle,line,polyline,polygon,rect,ellipse").length : 0,
      // the mask painted with background-color; as an element the svg strokes with the inherited colour,
      // and a holder still painting its own background would be the filled block the reject reported
      background: getComputedStyle(el).backgroundColor,
      colour: getComputedStyle(el).color,
      box: { x: r.x, y: r.y, w: r.width, h: r.height },
    };
  }));
  expect(icons.length, "the document really contains callout icons to check").toBeGreaterThanOrEqual(5);
  expect(icons.filter((i) => i.shapes === 0), `an icon holder arrived with no drawing :: ${JSON.stringify(icons)}`).toEqual([]);
  const painted = icons.filter((i) => !/^rgba\(0, 0, 0, 0\)$|^transparent$/.test(i.background));
  expect(painted, `an icon holder still paints its own block behind the drawing :: ${JSON.stringify(painted)}`).toEqual([]);
  // …and the types kept their palette: five callouts, five different stroke colours
  expect(new Set(icons.map((i) => i.colour)).size, `the icons all drew in one colour :: ${JSON.stringify(icons.map((i) => [i.icon, i.colour]))}`)
    .toBeGreaterThanOrEqual(4);
  // INK, not markup: a screenshot of each holder must contain pixels that are not its background.
  //
  // Taken from the ELEMENT, not from a clip rectangle. A rect is viewport-relative and a clip is
  // page-relative, so the third icon down came back 28x3 — the part of it that was still above the fold
  // and read as "no ink" while it was drawing perfectly (measured: 18 foreground of 84, against 210 of 784
  // for the one above it). Playwright scrolls the element into view for an element screenshot.
  const holders = opened.locator("[data-export-icon]");
  for (const [i, icon] of icons.entries()) {
    const { foreground, total } = countForegroundPixels(await holders.nth(i).screenshot());
    expect(foreground, `the ${icon.icon} icon drew no ink in the saved file (${foreground} of ${total})`).toBeGreaterThan(20);
  }

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

  // 2b. #85 re-measure FAIL-2: VERTICAL RHYTHM. The parity probes above compare per-element
  // properties, which a document with every block flush against the next passes untouched — the
  // re-measure read 415.6px of editor height arriving as 271.6px. Pin the gap itself: consecutive
  // top-level blocks in the opened file are separated, and separated by the SAME body line box the
  // editor's blank line occupies (a blank line is one line box — no magic number here).
  const rhythm = await opened.evaluate(() => {
    const root = document.querySelector("main.wks-export-doc")!
    const kids = [...root.children].filter((el) => (el as HTMLElement).offsetParent !== null)
    const gaps: number[] = []
    for (let i = 1; i < kids.length; i++) {
      const prev = kids[i - 1]!.getBoundingClientRect()
      const cur = kids[i]!.getBoundingClientRect()
      gaps.push(Math.round(cur.top - prev.bottom))
    }
    const p = root.querySelector("p")!
    return { gaps, bodyLineBox: Math.round(parseFloat(getComputedStyle(p).lineHeight)) }
  })
  expect(rhythm.gaps.length, "the fixture has consecutive blocks to measure").toBeGreaterThan(2)
  expect(Math.min(...rhythm.gaps), "no two blocks are flush (the -35% cramping)").toBeGreaterThan(0)
  expect(rhythm.gaps.some((g) => g === rhythm.bodyLineBox), "the block gap IS the editor's blank line").toBe(true)

  // 3. #636 (user ruling): the file ENDS with room. "
  // " — about the saved file, not the app, which is where the first attempt
  // at this went. A document that stops flush against the bottom of the window reads as one that was cut
  // off rather than one that finished.
  //
  // Measured against the WINDOW rather than as a CSS value, because that is the complaint: what matters
  // is how much empty space follows the last thing you read when you have scrolled as far as you can.
  const tail = await opened.evaluate(() => {
    window.scrollTo(0, document.documentElement.scrollHeight);
    const root = document.querySelector("main.wks-export-doc")!;
    const kids = [...root.children].filter((el) => (el as HTMLElement).offsetParent !== null);
    const last = kids[kids.length - 1]!.getBoundingClientRect();
    return { below: Math.round(document.documentElement.scrollHeight - (last.bottom + window.scrollY)), viewport: window.innerHeight };
  });
  expect(tail.below, `only ${tail.below}px follows the last block of the saved file`).toBeGreaterThan(96);

  // 4. the SAME opened file under print media: fixing "blank on screen" must not bring back "blank in
  // print" (the marker round-tripcalled out). Root visible in BOTH media, pinned side by side.
  await opened.emulateMedia({ media: "print" });
  const printDisplay = await root.evaluate((el) => getComputedStyle(el).display);
  expect(printDisplay, "the opened file's root is visible under print media too").not.toBe("none");
  const printBox = await root.boundingBox();
  expect(printBox, "…and has a box in print").not.toBeNull();
  expect(printBox!.height, "…with real height in print").toBeGreaterThan(100);
  await opened.emulateMedia({ media: null });

  await ctx.close();
});


// #85 (review rejection): `:::embed-page` reached the saved file saying "loading" — forever. Its
// siblings are honest (`children` / `tagged` declare `exportFidelity: "degrade"` and say so in words);
// transclude declares **preserve**, which is a promise that the content survives the file. A placeholder
// baked at the moment of serialisation keeps none of it and tells the reader to wait for something that
// will never arrive.
//
// The fix is (a): the export gets the resolver the screen has, and WAITS. So the measurement is the saved
// BYTES — the embedded page's own words have to be in them.
test("#85an embedded page travels with the file, not a 'loading' that never resolves", async ({ page }) => {
  test.setTimeout(240_000);
  await page.addInitScript(() => { try { localStorage.setItem("wks.lang", "ja"); } catch { /* private mode */ } });
  const stamp = Date.now();
  const TARGET_BODY = `embedded-body-${stamp}`;

  // the page being embedded: published, so the resolver can see it
  const targetId = await openScratch(page, `export85-target-${stamp}`);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.evaluate((text) => {
    const el = document.querySelector("[data-pane=preview] .cm-content") as { cmView?: { view?: unknown }; cmTile?: { view?: unknown } } | null;
    const view = (el?.cmView?.view ?? el?.cmTile?.view) as { state: { doc: { length: number } }; dispatch(t: unknown): void } | undefined;
    if (!view) throw new Error("no editor view for the embed target");
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
  }, `# target\n\n${TARGET_BODY}\n`);
  await sleep(1200);
  await page.evaluate(async ({ api, pageId }) => {
    const res = await fetch(`${api}/pages/${pageId}/publish`, { method: "POST", headers: { Authorization: "Bearer dev-token" } });
    if (!res.ok) throw new Error(`publishing the embed target failed: ${res.status}`);
  }, { api: API, pageId: targetId });

  // the page doing the embedding, beside the two macros that are honest about degrading
  await openScratch(page, `export85-host-${stamp}`);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.evaluate((text) => {
    const el = document.querySelector("[data-pane=preview] .cm-content") as { cmView?: { view?: unknown }; cmTile?: { view?: unknown } } | null;
    const view = (el?.cmView?.view ?? el?.cmTile?.view) as { state: { doc: { length: number } }; dispatch(t: unknown): void } | undefined;
    if (!view) throw new Error("no editor view for the embedding page");
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
  }, `# host\n\n:::embed-page\n${targetId}\n:::\n\n:::children\n:::\n`);
  await sleep(1800);

  await page.click("[data-testid=page-overflow-trigger]");
  const dl = page.waitForEvent("download");
  await page.getByTestId("export-page-html").click();
  const download = await dl;
  const dir = mkdtempSync(join(tmpdir(), "wks-export-embed-"));
  const savedPath = join(dir, "embed.html");
  await download.saveAs(savedPath);
  const bytes = readFileSync(savedPath, "utf8");

  // the promise `preserve` makes: the embedded page's words are in the file
  expect(bytes, "the embedded page's body did not travel").toContain(TARGET_BODY);
  // …and NO macro reached the file in a transient state. Measured on the attribute `showPlaceholder`
  // stamps (`data-wks-placeholder`), not on the words: the class this ticket names is "the next async
  // macro does the same thing", and a wording check would only ever catch this one. `loading` is the
  // transient state — a state that says "wait" in a file nobody can wait in. The settled ones
  // (`empty-page`, and the degrade sentences `children` / `tagged` write) are FINE and must survive,
  // which is why this refuses one state rather than the attribute.
  // …and the transient placeholder is not in the file. Measured as WORDS, deliberately: the attribute
  // `showPlaceholder` stamps (`data-wks-placeholder`) does not survive into the saved bytes — checked, and
  // an assertion on it passed vacuously — so the reader's own evidence is the sentence. The run is pinned
  // to Japanese above so the expected words are deterministic.
  expect(bytes, 'the file still says "loading" — the embed never resolved').not.toContain("読み込み中");
  // The sibling that DOES degrade still says so: this fix must not turn every macro silent. That is the
  // other half of the ruling — `children` promises `degrade` and keeps its sentence, `embed-page` promises
  // `preserve` and now keeps its content, and neither is allowed to become the other.
  expect(bytes, "the degrade sentence a sibling macro promises is gone").toContain("この面では表示されません");
  expect(bytes.length, "a non-trivial document was saved").toBeGreaterThan(5_000);
});
