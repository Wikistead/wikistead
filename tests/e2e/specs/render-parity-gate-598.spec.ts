import { test, expect, type Page } from "@playwright/test";
import { readFileSync, readdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openScratch, enterEdit, sleep, API } from "../helpers";

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
  // #598 identity slice: elements the saved document does not carry under their own name. Recorded
  // rather than hidden, and the assertion is EQUALITY — fixing one fails the gate until the line goes.
  //
  // `tabs` is the first thing this dimension found, and the follow-up measurement narrowed it: the
  // CONTENT is in the saved file (its pane text is there), so the export does not drop it — it arrives
  // ANONYMOUS. `columns`, the same kind of container, is named. The difference worth chasing is that the
  // tabs widget REBUILDS itself (it keeps an active-tab index across re-renders), which would replace the
  // element the stamp was put on. Not yet measured, so not yet asserted — recorded here so the gate is
  // green and honest rather than green and quiet.
  unidentified: ["tabs"] as string[],
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
    for (const m of src.matchAll(/kind:\s*"fence"[\s\S]{0,200}?lang:\s*"([a-z0-9-]+)"/g)) {
      found.set(`fence:${m[1]}`, { kind: "fence", name: m[1]!, body: bodyFor(m[1]!) });
    }
    for (const m of src.matchAll(/kind:\s*"directive"[\s\S]{0,200}?name:\s*"([a-z0-9-]+)"/g)) {
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
    case "table": return "| H |\n| --- |\n| c |";
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
  const elements = discoverMacros();
  expect(elements.length, "the registry scan found macros (an empty scan proves nothing)").toBeGreaterThan(8);

  await page.route("**/plantuml/render", (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: PLANTUML_PNG }));

  // the page an :::embed-page can actually embed — otherwise its placeholder is correct behaviour and
  // the gate would be measuring the fixture rather than the product
  const target = await openScratch(page, `parity598-target-${Date.now()}`);
  await page.evaluate(async ({ api, pageId }) => {
    await fetch(`${api}/pages/${pageId}/publish`, { method: "POST", headers: { Authorization: "Bearer dev-token" } });
  }, { api: API, pageId: target });
  TRANSCLUDE_TARGET.ref = target;

  await authorAndPublish(page, fixture(elements));

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

  // ---- 1a. per-element identity: is THIS element on the page a reader gets? ----
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
