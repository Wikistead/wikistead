import { test, expect, type Page } from "@playwright/test";
import { readFileSync, readdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openScratch, enterEdit, sleep, API, setPublicSurface } from "../helpers";
import { fileURLToPath } from "node:url";

// #598 public slice: the public surface is gated by an FGA tuple, written straight against the e2e store
// the way public-page.spec.ts does it — the product has no "make this public" button that a gate should
// be exercising here, and borrowing that spec's idiom keeps one way of doing it.
const repoEnv = readFileSync(fileURLToPath(new URL("../../../.env.e2e.local", import.meta.url)), "utf8");
const FGA_STORE = /OPENFGA_STORE_ID=(.+)/.exec(repoEnv)![1]!.trim();
const FGA_MODEL = /OPENFGA_MODEL_ID=(.+)/.exec(repoEnv)![1]!.trim();
// From the SAME env file the store id comes from. public-page.spec.ts hardcodes 8090, which is the
// unoffset stack — this stack is offset-isolated (WKS_STACK_OFFSET), so the port moves with it and a
// literal would write the tuple into somebody else's store, or nowhere.
const FGA_URL = /OPENFGA_API_URL=(.+)/.exec(repoEnv)![1]!.trim();
async function makePublic(pageId: string): Promise<void> {
  const res = await fetch(`${FGA_URL}/stores/${FGA_STORE}/write`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      writes: { tuple_keys: [{ user: "user:*", relation: "view_base", object: `page:${pageId}` }] },
      authorization_model_id: FGA_MODEL,
    }),
  });
  if (!res.ok && !(await res.text()).includes("already exists")) throw new Error(`could not publish ${pageId}`);
}

// #598 / ADR-191: the parity gate. Every element, every surface, one run — and it goes red when a
// surface loses something instead of a person finding it five reviews later.
//
// ". Five #85 rejects and three #207 rejects were all the same shape — an element that draws
// on one surface and not on another — and each was fixed one at a time because nothing compared them.
//
// DISCOVERY, not a list. The elements come from the macro REGISTRY source: every `kind: "fence"` with a
// `lang`, every `kind: "directive"` with a `name`. Registering a macro therefore adds a checked element
// with no edit here — which is the #544 lesson (an enumerated pin waves the N+1th case through).
//
// WHAT THIS SLICE MEASURES (and what it does not, said plainly)
// 1. the element survives — its raw marker (``` / :::) never reaches the saved file, and no "…"
// placeholder stands where content should be;
// 2. nothing is invisible on paper — under `print` media the saved document hides no block;
// 3. a diagram is a picture — mermaid / plantuml / excalidraw arrive as <svg> or <img>, not source;
// 4. the file is self-contained — opening it raises no failed resource load (the ERR_FILE_NOT_FOUND
// class, which is how the fonts were found to be absent).
// NOT YET: computed-style equality (colour, line-height, margins, font family) across the surfaces.
// That is the next slice and it is deliberately absent rather than half-done — this one has to be
// green and honest first.
// KNOWN RED, with the ticket that owns each one. The gate lands with today's defects recorded rather
// than hidden: the assertion is EQUALITY, so a new failure fails the gate AND a fixed one fails it too,
// with a message telling you to delete the line. Nothing gets grandfathered by accident, and the list
// can only shrink.
const KNOWN_RED = {
  // (empty) — #600 fixed the one that was here: an embed with no host seam used to render "…", and the
  // gate demanded its removal from this list the moment the placeholder started naming itself. That is
  // the list working: it shrinks, and it says so.
  placeholders: [] as string[],
  // #85 ③ / ADR-194 addendum (ruling pending): the copied CSS carries @font-face rules whose url is
  // root-absolute, so opening the file asks the filesystem root for fonts that are not there.
  failedRequests: [/wikistead-mono|udevgothic|\.woff2$/],
  // #598 registered macros that ended up in the GENERIC BOX — present, but nothing rendered them.
  // (empty) — this dimension exists because the review measured the gate passing on a dummy macro
  // registered with no working renderer, which is the exact failure the ticket was opened for.
  unrendered: [] as string[],
  // #598 identity slice: elements the saved document does not carry under their own name. Recorded
  // rather than hidden, and the assertion is EQUALITY — fixing one fails the gate until the line goes.
  //
  // (empty) — `tabs` was the first thing this dimension found and it is fixed: the export FLATTENS a tab
  // strip into titled sections (#85: paper has no "one at a time"), building a fresh element and leaving
  // the name behind. The content was always there; the element had no identity. Fixed where the rebuild
  // happens, which is the general rule this recorded — a transform that rebuilds a macro's element on the
  // way out carries its name across.
  unidentified: [] as string[],
  // #598 computed slice: elements whose TYPOGRAPHY (face, size, line height, weight, slant) differs
  // between the app and the saved file. Layout is not compared — see the rule at the assertion.
  typographyDrift: [] as string[],
  // #598 colour slice: text in the saved file that fails the 3:1 floor against its own background.
  illegible: [] as string[],
  // #598 print slice: named elements whose box collapses under print media (present, visible, and
  // occupying nothing — the failure a display-value check cannot see).
  flatOnPaper: [] as string[],
  // #598 public slice: elements the SERVER-rendered public page does not carry under their own name.
  missingPublicly: [] as string[],
  // #598 (review, 2026-08-04): elements whose STRUCTURE differs between surfaces — present,
  // complete, correctly named, and a different KIND of thing. The reject that opened this dimension
  // :::table drew a bordered grid on screen and borderless plain text everywhere else, because its
  // decoration lived in the CodeMirror theme (.cm-editor scope). No other dimension could see it: the
  // box has area (flatOnPaper), the text is right (typography), the name is right (identity).
  // (empty) — #207 moved the rule to prose.css, where every surface can reach it, and this dimension
  // demanded its own line's removal the moment the borders arrived. The list only shrinks.
  structureDrift: [] as string[],
  // #207 the fifth surface — the print PORTAL, which is what the BROWSER's own File → Print takes.
  // Three of that review's findings were measured here first and are FIXED: a tab strip hid the
  // panels nobody had selected, plantuml printed as its own source, and an external embed printed the
  // sentence "not shown on this surface".
  //
  // The fourth is this dimension's own discovery, recorded rather than hidden (#207): a page embed prints
  // "loading" forever. Nothing installs the transclude seam outside the editor's own widget, so on this
  // surface the placeholder has nobody to swap it out — the same shape as the two above, and the reason
  // it needs its own slice is that resolving an embed means an authenticated fetch per reference, which
  // the portal has no way to make today.
  onPaper: ["embed-page: printed a placeholder (loading)"] as string[],
} as const;

// Macros that legitimately render NOTHING with the fixture's data: a tag list with no tagged pages and
// a child list with no children are empty by design (#370 — an empty query draws nothing rather than an
// empty box). The next slice gives them data; until then they are named here rather than silently
// skipped, so "we do not check these two" is visible.
const RENDERS_NOTHING_WITHOUT_DATA = ["tagged", "children"];

const MACRO_DIR = resolve(import.meta.dirname, "../../../apps/web/src/editor/macros");

interface Element { kind: "fence" | "directive"; name: string; body: string }

/** The registry, read from source. A new macro shows up here without this file being edited. */
function discoverMacros(): Element[] {
  const found = new Map<string, Element>();
  for (const file of readdirSync(MACRO_DIR).filter((f) => f.endsWith(".ts") && !f.includes(".test."))) {
    const src = readFileSync(join(MACRO_DIR, file), "utf8");
    // #609 found the gap this window closes: a 200-char window between `kind:` and the name silently
    // dropped `embed-external` — a few comment lines between the two fields pushed the name out of reach.
    // A discovery walk that quietly loses an element is the exact failure this gate forbids, so the
    // window is generous and the caller asserts a name it knows must be present.
    for (const m of src.matchAll(/kind:\s*"fence"[\s\S]{0,800}?\blang:\s*"([a-z0-9-]+)"/g)) {
      found.set(`fence:${m[1]}`, { kind: "fence", name: m[1]!, body: bodyFor(m[1]!) });
    }
    for (const m of src.matchAll(/kind:\s*"directive"[\s\S]{0,800}?\bname:\s*"([a-z0-9-]+)"/g)) {
      found.set(`directive:${m[1]}`, { kind: "directive", name: m[1]!, body: bodyFor(m[1]!) });
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Filled in before the fixture is built: an embed-page needs a page to embed. */
const TRANSCLUDE_TARGET = { ref: "" };

const EXCALIDRAW = JSON.stringify({
  type: "excalidraw", version: 2, appState: {}, files: {},
  elements: [{
    id: "r1", type: "rectangle", x: 0, y: 0, width: 90, height: 60, angle: 0, strokeColor: "#1e1e1e",
    backgroundColor: "#a5d8ff", fillStyle: "solid", strokeWidth: 2, strokeStyle: "solid", roughness: 1,
    opacity: 100, groupIds: [], frameId: null, roundness: null, seed: 1, version: 1, versionNonce: 1,
    isDeleted: false, boundElements: null, updated: 1, link: null, locked: false,
  }],
});

/** A body each macro can actually render. Unknown macros get prose, which every renderer accepts. */
function bodyFor(name: string): string {
  switch (name) {
    case "mermaid": return "graph TD; A-->B;";
    case "plantuml": return "@startuml\nA -> B\n@enduml";
    case "excalidraw": return EXCALIDRAW;
    // `:::table`'s body is HTML by design (pipe syntax is the ordinary GFM table, a different element).
    // It was pipe syntax here, which renders zero rows — so the fixture was handing the macro something it
    // cannot draw and then the gate measured the FIXTURE's emptiness. Found by the placeholder dimension.
    case "table": return "<table><tr><th>H</th></tr><tr><td>c</td></tr></table>";
    case "columns": return ":::column\nleft column text\n:::\n:::column\nright column text\n:::";
    case "tabs": return ":::tab[Alpha]\nalpha pane text\n:::\n:::tab[Beta]\nbeta pane text\n:::";
    case "embed": return "https://example.com/thing";
    // an embed-page with nothing to point at is a placeholder BY DESIGN, so the gate gives it a real
    // target: the fixture publishes a second page first and puts its id here (set at run time).
    case "embed-page": return TRANSCLUDE_TARGET.ref;
    default: return `${name} body text`;
  }
}

const fixture = (elements: Element[]): string => [
  "# Parity heading",
  "",
  "ordinary body text",
  "",
  ...elements.flatMap((e) => e.kind === "fence"
    // a container directive needs one more colon than the deepest nesting inside it
    ? ["```" + e.name, e.body, "```", ""]
    : [(e.name === "tabs" || e.name === "columns" ? "::::" : ":::") + e.name + (e.name === "details" ? "[Folded]" : ""), e.body, e.name === "tabs" || e.name === "columns" ? "::::" : ":::", ""]),
  "| H1 | H2 |",
  "| --- | --- |",
  "| a | b |",
  "",
].join("\n");

const PLANTUML_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

async function authorAndPublish(page: Page, md: string): Promise<string> {
  const id = await openScratch(page, `parity598-${Date.now()}`);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  // through CM's dispatch: typing a fence info string trips auto-closing quotes (export-parity-85)
  await page.evaluate((text) => {
    const el = document.querySelector("[data-pane=preview] .cm-content") as { cmView?: { view?: unknown }; cmTile?: { view?: unknown } } | null;
    const view = (el?.cmView?.view ?? el?.cmTile?.view) as { state: { doc: { length: number } }; dispatch(t: unknown): void } | undefined;
    if (!view) throw new Error("no editor view to write the fixture into");
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
  }, md);
  await sleep(1500);
  await page.evaluate(async ({ api, pageId }) => {
    await fetch(`${api}/pages/${pageId}/publish`, { method: "POST", headers: { Authorization: "Bearer dev-token" } });
  }, { api: API, pageId: id });
  await page.reload();
  await page.waitForSelector("[data-pane=preview] .cm-content");
  await sleep(2000);
  return id;
}

test("#598: every registered element survives the export, the file, and the page", async ({ page, browser }) => {
  test.setTimeout(300_000);
  // Discovery happens twice on purpose: once to know WHAT exists (so the transclude target can be created
  // before any body is built), then again once TRANSCLUDE_TARGET.ref is filled in. Building the bodies
  // first left `:::embed-page` with an empty body, and an empty body is a legitimate placeholder — so the
  // gate was measuring its own fixture. (Found by the placeholder dimension, which is what it is for.)
  expect(discoverMacros().length, "the registry scan found macros (an empty scan proves nothing)").toBeGreaterThan(8);
  expect(discoverMacros().map((m) => m.name), "the walk sees the element the 200-char window used to drop").toContain("embed-external");

  await page.route("**/plantuml/render", (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: PLANTUML_PNG }));

  // the page an :::embed-page can actually embed — otherwise its placeholder is correct behaviour and
  // the gate would be measuring the fixture rather than the product
  const target = await openScratch(page, `parity598-target-${Date.now()}`);
  await page.evaluate(async ({ api, pageId }) => {
    await fetch(`${api}/pages/${pageId}/publish`, { method: "POST", headers: { Authorization: "Bearer dev-token" } });
  }, { api: API, pageId: target });
  TRANSCLUDE_TARGET.ref = target;

  const elements = discoverMacros(); // now every body can name what it needs
  const fixturePageId = await authorAndPublish(page, fixture(elements));

  await page.click("[data-testid=page-overflow-trigger]");
  const dl = page.waitForEvent("download");
  await page.getByTestId("export-page-html").click();
  const savedPath = join(mkdtempSync(join(tmpdir(), "wks-parity-598-")), "export.html");
  await (await dl).saveAs(savedPath);
  const bytes = readFileSync(savedPath, "utf8");

  // ---- 1. the element survives: no raw marker, no placeholder ----
  for (const e of elements) {
    const marker = e.kind === "fence" ? "```" + e.name : ":::" + e.name;
    expect(bytes, `${e.kind} ${e.name}: its raw marker reached the file`).not.toContain(marker);
  }
  // (the placeholder check runs against the DOM below, not the bytes: a stylesheet that happens to
  // contain an ellipsis in a `content:` rule is not an element that failed to render)

  // ---- open the saved file with the app closed: this is the document a reader gets ----
  const ctx = await browser.newContext();
  const opened = await ctx.newPage();
  const failed: string[] = [];
  opened.on("requestfailed", (r) => failed.push(`${r.failure()?.errorText ?? "failed"} ${r.url().slice(0, 120)}`));
  await opened.goto(`file://${savedPath}`);
  await sleep(700);

  // ---- 1a. nobody drew it: a registered macro that ended up in the generic box ----
  //
  // The identity dimension below asks whether an element is on the surface. This one asks whether anything
  // RENDERED it, which is a different question and the one the ticket is about: a macro that is registered
  // and not wired into a surface still produces a box there (the generic fallback), and while the name came
  // from the source text that box wore the macro's own name — so the identity check passed on a macro
  // nothing drew. Measured in the review with a dummy macro: green, on the defect this gate exists
  // for.
  //
  // The name now says who drew it: a macro's own renderer stamps `data-wks-el`, the fallback stamps
  // `data-wks-el-fallback`. So an unwired macro fails BOTH lines, and this one says why in one word.
  //
  // Asked of the app surface as well as the file: the mirror failure (wired for export, not for reading)
  // is the same defect facing the other way.
  const fellBackOn = async (p: Page, where: string) => (await p.evaluate(() =>
    [...new Set([...document.querySelectorAll("[data-wks-el-fallback]")].map((el) => el.getAttribute("data-wks-el-fallback") ?? ""))]))
    .filter((name) => elements.some((e) => e.name === name))
    .map((name) => `${name}: nothing rendered it in the ${where} (generic box)`);
  const unrendered = [...await fellBackOn(opened, "saved file"), ...await fellBackOn(page, "app")].sort();
  expect(
    unrendered,
    "a registered macro fell through to the generic box — it is not wired to that surface. " +
    "If you FIXED one, delete it from KNOWN_RED",
  ).toEqual([...KNOWN_RED.unrendered].sort());

  // ---- 1a′. per-element identity: is THIS element on the page a reader gets? ----
  //
  // The slice this replaces was withdrawn for a good reason: it compared a per-macro CSS marker across
  // surfaces and called `details` missing, because a CONTAINER macro is a CSS box while editing and a
  // semantic `<details>` in the export. The marker legitimately changes shape, so the comparison was
  // measuring the styling rather than the element.
  //
  // The shared visitor now NAMES what it emitted (`data-wks-el`, stamped once at the dispatch, so every
  // surface built on that visitor carries it). The question is exact: for each macro in the registry,
  // is an element with its name in the saved document. A macro that transforms is still itself; a macro
  // that silently degraded into a paragraph is not.
  const identified = await opened.evaluate(() =>
    [...new Set([...document.querySelectorAll("main.wks-export-doc [data-wks-el]")].map((el) => el.getAttribute("data-wks-el") ?? ""))]);
  const missing = elements
    .map((e) => e.name)
    .filter((name) => !identified.includes(name))
    .filter((name) => !RENDERS_NOTHING_WITHOUT_DATA.includes(name))
    .sort();
  expect(
    missing,
    `an element is not in the exported document under its own name (present: ${identified.sort().join(", ")}). ` +
    "If you FIXED one, delete it from KNOWN_RED — the list only shrinks",
  ).toEqual([...KNOWN_RED.unidentified].sort());

  // ---- 1c. the type is the same type: typography parity, element by element ----
  //
  // The first computed-style dimension, and the one #85 kept failing on: a document that opens looking
  // like a different document is not the one that was written, however complete its content is. The
  // identity stamped above is what makes this exact — a table is compared with a table rather than "the
  // fourth block" with "the fourth block".
  //
  // THE RULE, written down before the properties were chosen, because a computed-style comparison with no
  // rule is a noise generator
  //
  // COMPARED — what the DOCUMENT says: the typeface, the size, the line height, the weight and slant.
  // These are the author's text. If they differ between the app and the saved file, the reader is
  // holding a different document.
  //
  // NOT COMPARED — what the SURFACE says: margins, padding, widths, backgrounds. A screen with editor
  // chrome and a printed page legitimately lay text out differently, and #207 (print margins) is a
  // ticket about exactly that being a separate decision. Comparing them here would fail forever and
  // teach everyone to ignore this gate.
  //
  // Colour is deliberately absent for now: the app follows the viewer's theme and the saved file bakes
  // one, so equality is the wrong assertion and "legible against its own background" is the right one
  // a different measurement, and its own slice.
  const TYPOGRAPHY = ["fontFamily", "fontSize", "lineHeight", "fontWeight", "fontStyle"] as const;
  const typographyOf = (p: Page) => p.evaluate((props: readonly string[]) =>
    Object.fromEntries([...document.querySelectorAll("[data-wks-el]")].map((el) => {
      const cs = getComputedStyle(el);
      const read = (k: string) => {
        const v = cs.getPropertyValue(k.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())) || "";
        // the family list is a fallback chain; the FIRST entry is the face the document asked for
        return k === "fontFamily" ? v.split(",")[0]!.replace(/["']/g, "").trim() : v.trim();
      };
      return [el.getAttribute("data-wks-el") ?? "", props.map((k) => `${k}=${read(k)}`).join(" ")];
    })), TYPOGRAPHY as unknown as string[]);
  const exportType = await typographyOf(opened);
  const readType = await typographyOf(page); // the app, still open on the same document
  const shared = Object.keys(exportType).filter((name) => readType[name]);
  expect(shared.length, "there are named elements on BOTH surfaces to compare (an empty intersection passes forever)").toBeGreaterThan(3);
  const drift = shared
    .filter((name) => readType[name] !== exportType[name])
    .map((name) => `${name}: app [${readType[name]}] vs file [${exportType[name]}]`)
    .sort();
  expect(
    drift,
    "an element does not read the same in the saved file as in the app. If you FIXED one, delete it from KNOWN_RED",
  ).toEqual([...KNOWN_RED.typographyDrift].sort());

  // ---- 1c2. an element is still the same KIND of thing ----
  //
  // Typography compares the author's text; this compares the element's own SKELETON. A table that loses
  // its cell borders is not a table with different styling — it reads as plain lines, a different kind
  // of thing — and no other dimension can see that happen: the box still has area, the text is intact,
  // the name is right. (The reject that opened this: :::table's grid decoration lives in the CodeMirror
  // theme, scoped to .cm-editor, so every surface outside the editor drew it bare.)
  //
  // The rule stays NARROW on purpose, like the typography rule above it: no equality on widths or
  // margins — the assertion is only that a structural signal is not PRESENT on one surface and ABSENT
  // on the other. One signal, computed the same way for every named element (no per-element table)
  // does anything inside the element draw an internal border?
  const structureOf = (p: Page, scope: string) => p.evaluate((sel: string) => {
    const out: Record<string, boolean> = {};
    for (const el of document.querySelectorAll(sel)) {
      const name = el.getAttribute("data-wks-el") ?? "";
      let bordered = false;
      for (const node of [el, ...el.querySelectorAll("*")]) {
        const cs = getComputedStyle(node);
        if ([cs.borderTopWidth, cs.borderBottomWidth, cs.borderLeftWidth, cs.borderRightWidth].some((w) => parseFloat(w) > 0)) { bordered = true; break; }
      }
      // several elements of one name (tabs' panels): bordered if ANY is — the OR is stable across the
      // legitimate transforms (a flattened tab strip keeps its headed sections' rules)
      out[name] = (out[name] ?? false) || bordered;
    }
    return out;
  }, scope);
  // The app side is the EDITOR's widgets (`.cm-editor [data-wks-el]`) — the surface a reader actually
  // looks at, and the one whose look is the ruling's reference. The first cut read `[data-wks-el]`
  // anywhere on the page, which resolved to the print PORTAL: a static render just like the file, so
  // the comparison was the file against a copy of itself and the table's missing grid stayed invisible.
  const exportStructure = await structureOf(opened, "main.wks-export-doc [data-wks-el]");
  const appStructure = await structureOf(page, ".cm-editor [data-wks-el]");
  // #207 the PORTAL is measured against the editor too — "1 " is exactly what a
  // file-only comparison would allow (a CSS rule reaching the file but not the portal, or vice versa).
  const portalStructure = await structureOf(page, "[data-print-root] [data-wks-el]");
  const structureShared = Object.keys(exportStructure).filter((name) => name in appStructure);
  expect(structureShared.length, "named elements exist on BOTH surfaces to compare (an empty intersection passes forever)").toBeGreaterThan(3);
  const structureDrift = [
    ...structureShared
      .filter((name) => appStructure[name] !== exportStructure[name])
      .map((name) => `${name}: draws internal borders in the ${appStructure[name] ? "app" : "saved file"} and none in the ${appStructure[name] ? "saved file" : "app"}`),
    ...Object.keys(portalStructure).filter((name) => name in appStructure)
      .filter((name) => appStructure[name] !== portalStructure[name])
      .map((name) => `${name}: draws internal borders in the ${appStructure[name] ? "app" : "print portal"} and none in the ${appStructure[name] ? "print portal" : "app"}`),
  ].sort();
  expect(
    structureDrift,
    "an element is a different kind of thing in the saved file. If you FIXED one, delete it from KNOWN_RED",
  ).toEqual([...KNOWN_RED.structureDrift].sort());

  // ---- 1d. the text is legible against the paper it landed on ----
  //
  // The colour question, asked the way it can be answered. Equality is the wrong assertion — the app
  // follows the viewer's theme and the saved file bakes one, so the same paragraph is legitimately a
  // different colour in each. What must hold is that whatever colour it ended up, it can be READ against
  // whatever background it ended up on. The failure this catches is the one that has actually happened
  // (a dark-theme colour token baked into a light document, #601's family): text that is present,
  // complete, correctly named, and invisible.
  //
  // WCAG's contrast ratio, at the LARGE-text threshold (3:1) rather than 4.5:1 — this is a floor for
  // "somebody wrote a colour that cannot be seen", not an accessibility audit of the theme, and a floor
  // that fails on borderline body text would be argued with instead of fixed.
  const illegible = await opened.evaluate(() => {
    const lum = (c: string): number => {
      const [r, g, b] = (c.match(/[\d.]+/g) ?? ["0", "0", "0"]).slice(0, 3).map(Number) as [number, number, number];
      const ch = [r, g, b].map((v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; });
      return 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!;
    };
    const opaqueBg = (el: Element): string => {
      for (let n: Element | null = el; n; n = n.parentElement) {
        const bg = getComputedStyle(n).backgroundColor;
        const a = Number((bg.match(/[\d.]+/g) ?? [])[3] ?? "1");
        if (a > 0.5 && bg !== "transparent") return bg;
      }
      return "rgb(255, 255, 255)"; // the page's own paper
    };
    const bad: string[] = [];
    for (const el of document.querySelectorAll("main.wks-export-doc [data-wks-el], main.wks-export-doc [data-wks-el] *")) {
      const text = [...el.childNodes].some((n) => n.nodeType === 3 && (n.textContent ?? "").trim().length > 0);
      if (!text) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "none") continue;
      const l1 = lum(cs.color), l2 = lum(opaqueBg(el));
      const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      if (ratio < 3) bad.push(`${el.closest("[data-wks-el]")?.getAttribute("data-wks-el") ?? "?"}: ${cs.color} on ${opaqueBg(el)} = ${ratio.toFixed(2)}:1`);
    }
    return [...new Set(bad)].sort();
  });
  expect(
    illegible,
    "text in the saved file cannot be read against its own background. If you FIXED one, delete it from KNOWN_RED",
  ).toEqual([...KNOWN_RED.illegible].sort());

  // ---- 1b. no element rendered as an ellipsis placeholder ----
  const placeholders = await opened.evaluate(() => Array.from(document.querySelectorAll("main.wks-export-doc *"))
    .filter((el) => el.children.length === 0 && (el.textContent ?? "").trim() === "…")
    .map((el) => `${el.className || el.tagName}`));
  expect(
    [...new Set(placeholders)].sort(),
    "an element rendered as an ellipsis. If you FIXED one, delete it from KNOWN_RED — the list only shrinks",
  ).toEqual([...KNOWN_RED.placeholders].sort());

  // ---- 3. a diagram is a picture ----
  for (const name of ["mermaid", "plantuml", "excalidraw"]) {
    if (!elements.some((e) => e.name === name)) continue;
    const drawn = await opened.evaluate((n) => {
      const host = document.querySelector(`.cm-lp-${n}`) ?? document.querySelector(`[data-testid="macro-${n}"]`);
      if (!host) return "missing";
      return host.querySelector("svg, img") ? "figure" : "source";
    }, name);
    expect(drawn, `${name}: the saved file carries its source, not a figure`).toBe("figure");
  }

  // ---- 1e. the PUBLIC reader gets the same elements ----
  //
  // The fourth surface: what a reader with no account gets. MEASURED, not assumed — the first version of
  // this comment said the public page is server-rendered HTML, and the break-check disproved it: removing
  // a name from the SERVER sink changed nothing here, while removing it from the DOM sink turned this red.
  // The public page is built in the browser from the same visitor the export uses. That is worth pinning
  // exactly because it is not obvious: the surface most likely to be assumed static is not.
  //
  // (The server sink therefore stays unstamped. Naming its output would have cost thirteen byte-exact
  // pins their current form and bought no measurement — the seam is there when a surface that consumes
  // it needs comparing.)
  //
  // Read from an anonymous context on purpose: a reader with no session is who this surface exists for,
  // and a signed-in fetch would quietly measure a different code path.
  await makePublic(fixturePageId);
  await setPublicSurface(page, true); // #253: the tenant switch gates the whole surface
  const anon = await browser.newContext();
  const anonPage = await anon.newPage();
  await anonPage.goto(`/pub/${fixturePageId}`);
  await sleep(800);
  const publicNames = await anonPage.evaluate(() =>
    [...new Set([...document.querySelectorAll("[data-wks-el]")].map((el) => el.getAttribute("data-wks-el") ?? ""))]);
  const missingPublicly = elements
    .map((e) => e.name)
    .filter((name) => !publicNames.includes(name))
    .filter((name) => !RENDERS_NOTHING_WITHOUT_DATA.includes(name))
    .sort();
  expect(publicNames.length, "the public page rendered named elements (an empty set proves nothing)").toBeGreaterThan(3);
  expect(
    missingPublicly,
    `an element is not on the public page under its own name (present: ${publicNames.sort().join(", ")}). ` +
    "If you FIXED one, delete it from KNOWN_RED",
  ).toEqual([...KNOWN_RED.missingPublicly].sort());
  await anon.close();

  // ---- 1f. THE OTHER PAPER: the print portal ----
  //
  // The app's own Print builds the export document — the file measured above — so every dimension so far
  // has been about the road the app controls. There is a second road it cannot: the BROWSER's File →
  // Print, which fires with no chance to build anything first, and which takes the portal (`PrintSurface`)
  // instead. That surface had no host seams at all, and #207's review found exactly what that
  // produces: a tab strip that hides the panels nobody selected (content, gone, on paper only), a plantuml
  // block printed as its own source, and an embed printed as the sentence that says it cannot be shown.
  //
  // Measured here rather than described, because a second renderer path is precisely what this gate exists
  // to keep honest — and none of the four surfaces above could see it.
  await page.emulateMedia({ media: "print" }); // the portal only becomes the document under print media
  await sleep(400);
  const portal = await page.evaluate(() => {
    const root = document.querySelector("[data-print-root]");
    if (!root) return { missing: true, bad: [] as string[] };
    const bad: string[] = [];
    for (const el of root.querySelectorAll("[data-wks-el]")) {
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      const name = el.getAttribute("data-wks-el") ?? "?";
      if (cs.display === "none" || cs.visibility === "hidden") bad.push(`${name}: hidden on paper`);
      else if (r.width < 1 || r.height < 1) bad.push(`${name}: occupies nothing on paper`);
    }
    // #207 content hidden INSIDE a container — asked kind-agnostically, because naming
    // `.cm-lp-tabpanel` here waved the closed <details> through, and the next disclosure macro would
    // slip past the same way. The question is the general one: does any element carry real text that
    // paper does not render? A closed details' body, a display:none panel, and whatever the third
    // disclosure macro hides all answer it without this file learning their names.
    // What must not happen is text being LOST: a hidden node whose words appear nowhere visible. Two
    // hidden-but-fine shapes taught this check its wording (measured, not guessed): a <style> inside a
    // mermaid SVG carries text that was never meant to render, and a tab bar's labels are hidden on
    // paper because the panels re-print them as their headings — the words are there, once each.
    const visibleText = (root as HTMLElement).innerText; // innerText is layout-aware: hidden text is absent
    for (const el of root.querySelectorAll("*")) {
      if (/^(STYLE|SCRIPT|TEMPLATE|TITLE|DEFS)$/i.test(el.tagName)) continue;
      const ownText = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent ?? "").join("").trim();
      if (ownText.length < 3) continue;
      // checkVisibility, not display/visibility/rect: a CLOSED <details>' body is hidden by
      // content-visibility on an internal slot, so it reports display:block AND a full-width rect while
      // painting nothing (measured: 1280x24 and invisible). checkVisibility is the browser's own
      // answer to "is this rendered", and it covers all three hiding mechanisms at once.
      const r = el.getBoundingClientRect();
      const hidden = !(el as Element & { checkVisibility(): boolean }).checkVisibility() || (r.width < 1 && r.height < 1);
      if (hidden && !visibleText.includes(ownText)) {
        bad.push(`text is lost on paper: "${ownText.slice(0, 24)}"`);
      }
    }
    // nobody printed a "this surface cannot show it" sentence
    for (const el of root.querySelectorAll("[data-wks-placeholder]")) {
      bad.push(`${el.closest("[data-wks-el]")?.getAttribute("data-wks-el") ?? "?"}: printed a placeholder (${el.getAttribute("data-wks-placeholder")})`);
    }
    // a diagram is a picture here too
    for (const name of ["mermaid", "plantuml", "excalidraw"]) {
      const host = root.querySelector(`.cm-lp-${name}, [data-testid="macro-${name}"]`);
      if (host && !host.querySelector("svg, img")) bad.push(`${name}: printed its source, not a figure`);
    }
    return { missing: false, bad: [...new Set(bad)].sort() };
  });
  expect(portal.missing, "the print portal is on the page (an absent portal would pass this forever)").toBe(false);
  expect(
    portal.bad,
    "the browser's own File → Print would lose or mangle this. If you FIXED one, delete it from KNOWN_RED",
  ).toEqual([...KNOWN_RED.onPaper].sort());
  await page.emulateMedia({ media: "screen" });

  // ---- 1g. paper diagrams are LIGHT, even when the screen is dark ----
  //
  // #207 (user review): a diagram BAKES the theme into its pixels at render time, so pinning
  // `data-theme="light"` on the paper document was never enough — the portal built while the app was dark
  // carried a dark mermaid onto white paper. The readability dimension cannot see this (a figure is not
  // text, so no contrast floor fires), which is exactly why it gets its own check. The pin: reload the
  // SAME page with the screen DARK, let the portal rebuild, and assert the mermaid node fill is not the
  // dark bake (measured values from the reject: light fill = rgb(236,236,255), dark bake = rgb(31,32,32)).
  await page.emulateMedia({ colorScheme: "dark" });
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
  await page.reload();
  await page.waitForSelector("[data-print-root]", { state: "attached", timeout: 20_000 });
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
  await sleep(2500); // the portal's diagrams fill in asynchronously
  const darkPaper = await page.evaluate(() => {
    const root = document.querySelector("[data-print-root]");
    const svg = root?.querySelector(".cm-lp-mermaid svg, [data-wks-el='mermaid'] svg");
    if (!svg) return { missing: true, fills: [] as string[] };
    const fills = new Set<string>();
    for (const el of svg.querySelectorAll("rect, polygon, path, circle")) {
      const f = getComputedStyle(el).fill;
      if (f && f !== "none") fills.add(f);
    }
    return { missing: false, fills: [...fills] };
  });
  expect(darkPaper.missing, "the portal's mermaid rendered (an absent figure would pass this forever)").toBe(false);
  // the ruled acceptance values, verbatim: light node fill = rgb(236,236,255); the dark bake's
  // node fill = rgb(31,32,32). Text/edge fills are dark in BOTH themes (black ink on white paper is
  // correct), so a generic darkness filter misfires — the node fill is the discriminator.
  expect(darkPaper.fills, "the light node fill is present — the paper render pinned light").toContain("rgb(236, 236, 255)");
  expect(darkPaper.fills, "the dark bake's node fill must not reach paper").not.toContain("rgb(31, 32, 32)");
  await page.emulateMedia({ colorScheme: "light" });
  await page.evaluate(() => { delete document.documentElement.dataset.theme; });
  await page.reload();
  await page.waitForSelector("[data-print-root]", { state: "attached", timeout: 20_000 });
  await sleep(400);
  await page.emulateMedia({ media: "screen" });

  // ---- 2. nothing is invisible on paper ----
  await opened.emulateMedia({ media: "print" });
  await sleep(300);
  const hidden = await opened.evaluate(() => {
    const out: string[] = [];
    for (const el of Array.from(document.querySelectorAll("main.wks-export-doc *"))) {
      if (!(el instanceof HTMLElement)) continue;
      if (!el.textContent?.trim()) continue;
      const c = getComputedStyle(el);
      if (c.display === "none" || c.visibility === "hidden") out.push(`${el.className || el.tagName}: ${el.textContent.trim().slice(0, 30)}`);
    }
    return out;
  });
  expect(hidden, "print media hides content that is on screen").toEqual([]);

  // …and NOT ONLY by `display: none`. A block can be present, visible and still occupy nothing — a
  // collapsed height, a zero width, a container whose children were absolutely positioned out of it. On
  // screen an author would notice; on paper nobody looks until it is printed. Now that every macro is
  // named, each one can be asked for its box under print media rather than for its display value.
  const flattened = await opened.evaluate(() =>
    [...document.querySelectorAll("main.wks-export-doc [data-wks-el]")]
      .map((el) => ({ name: el.getAttribute("data-wks-el") ?? "?", r: el.getBoundingClientRect() }))
      .filter(({ r }) => r.width < 1 || r.height < 1)
      .map(({ name, r }) => `${name}: ${Math.round(r.width)}x${Math.round(r.height)} on paper`)
      .sort());
  expect(
    flattened,
    "an element occupies nothing on paper. If you FIXED one, delete it from KNOWN_RED",
  ).toEqual([...KNOWN_RED.flatOnPaper].sort());
  await opened.emulateMedia({ media: "screen" });

  // ---- 4. the file is self-contained ----
  const unexpectedFailures = failed.filter((f) => !KNOWN_RED.failedRequests.some((re) => re.test(f)));
  expect(unexpectedFailures, "the opened file asked for something it did not carry").toEqual([]);
  // …and the known one must still BE known: when the fonts travel, this line goes red and the entry
  // comes out of KNOWN_RED with the fix.
  expect(
    failed.some((f) => KNOWN_RED.failedRequests.some((re) => re.test(f))),
    "the font requests no longer fail — delete that entry from KNOWN_RED",
  ).toBe(true);

  await ctx.close();
});
