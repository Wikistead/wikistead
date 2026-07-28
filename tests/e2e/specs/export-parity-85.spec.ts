import { test, expect } from "@playwright/test";
import { openScratch, enterEdit, sleep, API } from "../helpers";

// #85 / ADR-194 (Option B) acceptance 1: the export and the screen have to LOOK THE SAME, and the previous
// review proved that per-item assertions cannot show that — every item passed while the two sides
// were plainly different documents. So this reads the same properties off BOTH surfaces and compares them
// to each other. Nothing here asserts a literal value: if the app's heading colour changes tomorrow, the
// export's must change with it or this goes red, which is the actual contract.
//
// Acceptance 2 rides along: a diagram must arrive as a drawn figure, not as its source.

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
  "::::columns",
  ":::column",
  "left column text",
  ":::",
  ":::column",
  "right column text",
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
].join("\n");

// The properties that made the rejection: "green sans headings against black monospace ones", a sans body,
// different table rules, a different callout box.
const PROBES: { name: string; selector: string; props: string[] }[] = [
  { name: "heading", selector: "h1, .cm-lp-h1", props: ["color", "fontFamily", "fontWeight"] },
  { name: "body text", selector: "p", props: ["fontFamily", "fontSize", "lineHeight"] },
  { name: "callout box", selector: "[class*=cm-lp-callout]", props: ["backgroundColor", "borderLeftColor", "borderLeftWidth"] },
  { name: "table cell", selector: "td", props: ["borderTopColor", "borderTopWidth", "padding"] },
];

type Probe = Record<string, Record<string, string> | null>;

const readProbes = `(root, probes) => {
  const out = {};
  for (const p of probes) {
    const el = root.querySelector(p.selector);
    if (!el) { out[p.name] = null; continue }
    const cs = getComputedStyle(el);
    const vals = {};
    for (const prop of p.props) vals[prop] = cs[prop];
    out[p.name] = vals;
  }
  return out;
}`;

// A real 1×1 PNG. The e2e stack runs no plantuml service, which is exactly how the blob: defect stayed
// invisible: the export ASKED the host, got nothing, and the source-card fallback looked like the
// correct degrade. Answering the render route ourselves puts a picture on the surface, so the gate can
// require the picture to reach the FILE in a form that outlives this browser session.
const PLANTUML_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

test("#85: the exported document and the app render the same document", async ({ page }) => {
  test.setTimeout(150_000);
  const plantumlAsks: string[] = [];
  page.on("request", (r) => { if (r.url().includes("/plantuml/render")) plantumlAsks.push(r.url()) });
  await page.route("**/plantuml/render", (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: PLANTUML_PNG }));
  const id = await openScratch(page, `exportparity-${Date.now()}`);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  // Written through CodeMirror's own dispatch rather than typed. Typing an info string like
  // `title="app.js" showLineNumbers {2}` trips CM's auto-closing of quotes and braces, so the document
  // that reached the page was not the one written here — which is why the fence chrome could not be
  // asserted from this fixture at all. A programmatic insert has no auto-close, and the doc is exactly
  // what the spec says it is.
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

  // Build the export the way the user does, and take the document out of the frame it printed.
  await page.addInitScript(() => { /* nothing — the frame's own print is harmless in headless */ });
  await page.keyboard.press("Control+p");
  await sleep(8000); // live macros draw, then the surface settles before it is serialized
  const html = await page.evaluate(() =>
    Array.from(document.querySelectorAll("iframe")).map((f) => (f as HTMLIFrameElement).srcdoc || "").filter(Boolean).pop() ?? "");
  expect(html.length, "the export document was built").toBeGreaterThan(0);

  // #85 (user ruling 2026-07-28): every tab's content reaches the file. On screen the strip shows one at a
  // time; on paper there is no "at a time", and the reader must not lose the text behind the tabs they
  // never clicked.
  expect(html, "the tab the reader saw").toContain("alpha pane text");
  expect(html, "…and the one they did not").toContain("beta pane text");
  expect(html, "each under its own label").toContain("Alpha");
  expect(html).toContain("Beta");

  // #85 (ruling): columns and the callout were already right; they are pinned so they stay that way while
  // the rest of the export moves. Both columns' text reaches the file, side by side as on screen (the
  // container class is what the app's own CSS lays out), and the callout keeps its panel structure.
  expect(html, "the left column").toContain("left column text");
  expect(html, "…and the right one").toContain("right column text");
  expect(html, "laid out by the app's own columns class").toContain("cm-lp-columns");
  expect(html, "the callout arrives as the panel the app draws").toContain("cm-lp-callout-panel");
  expect(html, "…keeping its label").toContain("Label");

  // #85: the fold keeps its look and its content — a disclosure in the file, open, so nothing is hidden
  // behind a triangle nobody can click on paper.
  expect(html, "the disclosure survives as one").toMatch(/<details[^>]*\sopen/);
  expect(html).toContain("Folded");
  expect(html, "…with its body readable").toContain("folded body text");

  // #85: the fence keeps its chrome — the filename tab, the line numbers, and the highlighted line. The
  // editor paints those; a file without them is not the same document.
  // #85: the fence keeps its chrome in the file — the filename tab, the line numbers, and the band on the
  // highlighted line. The editor paints those, and a document without them is not the same document. This
  // became assertable once the fixture stopped being typed (see the dispatch above).
  expect(html, "the filename tab").toContain("app.js");
  expect(html, "line numbers, as the editor renders them").toContain("cm-lp-code-numbered");
  expect(html, "…with their values").toContain('data-linenum="2"');
  expect(html, "and the highlighted line keeps its band").toContain("cm-lp-code-hl");

  // Acceptance 2: the diagram is a figure — for BOTH kinds. mermaid draws itself in the browser; plantuml
  // is drawn by the host, and the export had nobody to ask, so it carried the fence source while the screen
  // showed the picture (#505 review rejection).
  expect(html, "a mermaid block reaches the file as a drawn figure").toContain("<svg");
  expect(html, "…not as its source").not.toContain("graph TD; A--&gt;B;");
  // A host-rendered diagram (plantuml) is drawn by the SERVER; the route above answers for the absent
  // service so the surface really gets a picture. What broke first was that the export never ASKED (no
  // host seam at all); what broke second was that the picture travelled as a blob: URL — alive in
  // the print frame, dead in the saved file. So both halves are pinned: the ask happens, and the picture
  // reaches the file as bytes, with no blob: reference left anywhere in it.
  expect(plantumlAsks.length, "the export asked the host to draw the plantuml block").toBeGreaterThan(0);
  expect(html, "the plantuml figure is baked in as bytes that outlive this session").toContain("data:image/png");
  expect(html, "no image points at a blob: handle that dies with this page").not.toContain('src="blob:');

  // #505 review rejection: the file must survive being PRINTED. The app's stylesheet travels with it, and its
  // print rule hides everything that is not the print root — which was this document itself.
  expect(html, "the document names itself the print root").toMatch(/<main[^>]*data-print-root/);

  // Read the same properties from the app…
  const appProbes = (await page.evaluate(
    ({ fn, probes }) => (new Function("return " + fn)())(document.querySelector("[data-pane=preview]") ?? document.body, probes),
    { fn: readProbes, probes: PROBES },
  )) as Probe;

  // …and from the exported file, loaded into a frame of our own so its own <style> applies.
  const exported = (await page.evaluate(async ({ fn, probes, doc }) => {
    const f = document.createElement("iframe");
    f.style.cssText = "position:fixed;left:-10000px;top:0;width:900px;height:900px;";
    document.body.appendChild(f);
    await new Promise<void>((resolve) => { f.addEventListener("load", () => resolve(), { once: true }); f.srcdoc = doc });
    await new Promise((r) => setTimeout(r, 400));
    const root = f.contentDocument!.body;
    const res = (new Function("return " + fn)())(root, probes);
    f.remove();
    return res;
  }, { fn: readProbes, probes: PROBES, doc: html })) as Probe;

  // Code is compared differently, and the reason is structural rather than convenient: the EDITING surface
  // draws a fence as decorated document lines, so there is no card element on that side to read against the
  // export's. What can be compared is the FACE — the export's code must use the app's code token, read out
  // of the running app rather than written here as a literal.
  const codeFace = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--font-code").trim());
  const exportedCode = await page.evaluate(async ({ doc }) => {
    const f = document.createElement("iframe");
    f.style.cssText = "position:fixed;left:-10000px;top:0;width:900px;height:900px;";
    document.body.appendChild(f);
    await new Promise<void>((resolve) => { f.addEventListener("load", () => resolve(), { once: true }); f.srcdoc = doc });
    await new Promise((r) => setTimeout(r, 300));
    const el = f.contentDocument!.body.querySelector(".cm-lp-fence-card pre, pre");
    const family = el ? getComputedStyle(el).fontFamily : null;
    f.remove();
    return family;
  }, { doc: html });
  expect(exportedCode, "the exported code block exists").not.toBeNull();
  expect(exportedCode!.replace(/\s+/g, ""), "…and wears the app's code face").toBe(codeFace.replace(/\s+/g, ""));

  // #505 ruling 2: and it is HIGHLIGHTED, in the app's own colours. The editor colours code through a
  // HighlightStyle; the read surface now runs the same style over the same grammar, so the keyword colour
  // is read off the running app and required of the file — a literal would just pin today's palette.
  // Resolved through a probe element so both sides speak computed rgb() — the raw custom-property text
  // (`#c678dd` vs `rgb(198, 120, 221)`) would never compare equal even when the colours are the same.
  const keywordColour = await page.evaluate(() => {
    const probe = document.createElement("span");
    probe.style.color = "var(--hl-keyword)";
    document.body.appendChild(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    return c;
  });
  const exportedColours = await page.evaluate(async ({ doc }) => {
    const f = document.createElement("iframe");
    f.style.cssText = "position:fixed;left:-10000px;top:0;width:900px;height:900px;";
    document.body.appendChild(f);
    await new Promise<void>((resolve) => { f.addEventListener("load", () => resolve(), { once: true }); f.srcdoc = doc });
    await new Promise((r) => setTimeout(r, 400));
    const spans = Array.from(f.contentDocument!.body.querySelectorAll("pre code span"));
    const out = spans.map((s) => ({ text: s.textContent || "", colour: getComputedStyle(s).color }));
    f.remove();
    return out;
  }, { doc: html });
  expect(exportedColours.length, "the exported code is tokenised, not one flat run of text").toBeGreaterThan(0);
  const constToken = exportedColours.find((c) => c.text.trim() === "const");
  expect(constToken, `the keyword is its own token (got ${JSON.stringify(exportedColours.slice(0, 6))})`).toBeTruthy();
  expect(keywordColour.length, "the app defines a keyword colour to compare against").toBeGreaterThan(0);
  // gate hole: both colours were read and neither was compared — the export could have highlighted
  // in anything and stayed green. This is the sentence the two reads were always for.
  expect(constToken!.colour, "…and it wears the app's own keyword colour").toBe(keywordColour);

  for (const probe of PROBES) {
    const a = appProbes[probe.name];
    const b = exported[probe.name];
    expect(a, `${probe.name}: missing on the app surface (fixture or selector is wrong, not the export)`).not.toBeNull();
    expect(b, `${probe.name}: missing from the exported document`).not.toBeNull();
    expect(b, `${probe.name}: the export does not match the screen`).toEqual(a);
  }
});
