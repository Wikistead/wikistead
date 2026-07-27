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
  ":::note[Label]",
  "callout body",
  ":::",
  "",
  "| H1 | H2 |",
  "| --- | --- |",
  "| a | b |",
  "",
  "```js",
  "const x = 1;",
  "```",
  "",
  "```mermaid",
  "graph TD; A-->B;",
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

test("#85: the exported document and the app render the same document", async ({ page }) => {
  test.setTimeout(150_000);
  const id = await openScratch(page, `exportparity-${Date.now()}`);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(FIXTURE);
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

  // Acceptance 2: the diagram is a figure.
  expect(html, "a mermaid block reaches the file as a drawn figure").toContain("<svg");
  expect(html, "…not as its source").not.toContain("graph TD; A--&gt;B;");

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

  for (const probe of PROBES) {
    const a = appProbes[probe.name];
    const b = exported[probe.name];
    expect(a, `${probe.name}: missing on the app surface (fixture or selector is wrong, not the export)`).not.toBeNull();
    expect(b, `${probe.name}: missing from the exported document`).not.toBeNull();
    expect(b, `${probe.name}: the export does not match the screen`).toEqual(a);
  }
});
