import { test, expect } from "@playwright/test";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { openScratch, enterEdit, sleep } from "../helpers";

// #609: clicking an empty macro's placeholder must not make the block vanish.
//
// The device found it on `:::table` alone: the click-to-edit exception (#154) fired on the empty state
// too, and the editor it opened had a zero-row grid to draw — a 10px sliver, which reads as "the
// placeholder disappeared and left an empty line". Every other macro kept its placeholder. The ruling
// applied is (a): while a macro is EMPTY, a click selects it like any other atom and the placeholder —
// whose own words say "Ctrl+↵ to edit" — stays on screen to be read.
//
// DISCOVERY, not a list (the ticket's own requirement): the macros come from the registry source, the
// same walk the parity gate uses, so the next in-editor-editing macro is covered without touching this
// file. What is asserted per element: the placeholder survives its own click, and the DOCUMENT is
// byte-identical afterwards (display-only — the invariant the whole decoration layer carries).
const MACRO_DIR = resolve(import.meta.dirname, "../../../apps/web/src/editor/macros");

function discoverMacros(): { kind: "fence" | "directive"; name: string }[] {
  const found = new Map<string, { kind: "fence" | "directive"; name: string }>();
  for (const file of readdirSync(MACRO_DIR).filter((f) => f.endsWith(".ts") && !f.includes(".test."))) {
    const src = readFileSync(join(MACRO_DIR, file), "utf8");
    // A 200-char window between `kind:` and the name MISSED two macros (embed-external, backlinks):
    // their registry entries carry a few comment lines between the two fields, which is normal prose,
    // not an exotic shape. A silent miss in a discovery walk is the exact failure discovery exists to
    // prevent, so the window is generous and the caller asserts names it knows must be present.
    for (const m of src.matchAll(/kind:\s*"fence"[\s\S]{0,800}?\blang:\s*"([a-z0-9-]+)"/g)) found.set(`f:${m[1]}`, { kind: "fence", name: m[1]! });
    for (const m of src.matchAll(/kind:\s*"directive"[\s\S]{0,800}?\bname:\s*"([a-z0-9-]+)"/g)) found.set(`d:${m[1]}`, { kind: "directive", name: m[1]! });
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

test("#609: no empty macro vanishes when its placeholder is clicked", async ({ page }) => {
  test.setTimeout(300_000);
  const macros = discoverMacros();
  expect(macros.length, "the registry scan found macros (an empty scan proves nothing)").toBeGreaterThan(8);
  // the one a 200-char window used to miss (a few comment lines between `kind:` and `name:` pushed the
  // name out of reach) — if the walk loses it again, say so by name. (`backlinks` is NOT expected: the
  // MacroWidget exempts it by name, but the macro itself is #307 and unbuilt — there is no registration
  // to discover.)
  expect(macros.map((m) => m.name), "the walk sees embed-external").toContain("embed-external");

  await openScratch(page, `empty609-${Date.now()}`);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");

  // One macro per round, because the first version of this walked one page of placeholders by index —
  // and a macro whose click legitimately swaps the placeholder for its raw source shifted every index
  // after it, so the walk clicked one block while naming another. Isolation is what makes the label on
  // a failure trustworthy.
  const outcomes: string[] = [];
  for (const m of macros) {
    const md = m.kind === "fence" ? "# x\n\n```" + m.name + "\n```\n\ntail\n" : `# x\n\n:::${m.name}\n:::\n\ntail\n`;
    await page.evaluate((text) => {
      const el = document.querySelector("[data-pane=preview] .cm-content") as { cmView?: { view?: unknown }; cmTile?: { view?: unknown } } | null;
      const view = (el?.cmView?.view ?? el?.cmTile?.view) as { state: { doc: { length: number } }; dispatch(t: unknown): void } | undefined;
      if (!view) throw new Error("no editor view");
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, selection: { anchor: 0 } });
    }, md);
    await sleep(500);
    const docOf = () => page.evaluate(() => {
      const el = document.querySelector("[data-pane=preview] .cm-content") as any;
      return (el?.cmView?.view ?? el?.cmTile?.view)?.state.doc.toString() as string;
    });
    const before = await docOf();

    // backlinks/children render no placeholder — an always-empty body is their normal state, and there
    // is nothing to click. Recorded in the outcome so the walk shows it did not skip them silently.
    if (await page.getByTestId("macro-empty").count() === 0) { outcomes.push(`${m.name}: no placeholder (by design)`); continue; }

    await page.getByTestId("macro-empty").first().click();
    await sleep(400);

    // The invariant is the CLASS one: after the click the block is still IDENTIFIABLY THERE. Two states
    // qualify, and both are rulings rather than accidents: the placeholder stays (the atom-select
    // macros, table now among them), or the raw source shows with its markers visible (the caret-in
    // reveal macros — mermaid/plantuml/tagged, whose fence line may carry the RichUI pill's text in
    // front of the marker, which is why this looks for the marker anywhere in the line). What must
    // never happen is what #609 found on table: neither — a sliver nobody can see.
    const stillThere = await page.evaluate(() => {
      if (document.querySelector("[data-testid=macro-empty]")) return "placeholder";
      const rawLine = [...document.querySelectorAll("[data-pane=preview] .cm-line")]
        .some((l) => /(:::|```)/.test(l.textContent ?? "") && (l as HTMLElement).offsetHeight > 0);
      return rawLine ? "raw" : "GONE";
    });
    expect(stillThere, `${m.name}: clicking the empty placeholder left nothing visible`).not.toBe("GONE");
    outcomes.push(`${m.name}: ${stillThere}`);

    // and no click edited the document — the decoration layer is display-only
    expect(await docOf(), `${m.name}: the document is byte-identical after the click`).toBe(before);
    await page.keyboard.press("Escape").catch(() => {});
    await sleep(150);
  }
  console.log("outcomes:", outcomes.join(" | "));
  // the walk actually measured clicks (a page of no-placeholder macros would pass vacuously)
  expect(outcomes.filter((o) => o.includes("placeholder") || o.includes("raw")).length).toBeGreaterThan(5);
  // …and the specific defect this ticket was opened for stays named: the empty table KEEPS its
  // placeholder, like the other atom-select macros, instead of entering an editor with nothing to draw
  expect(outcomes, "the empty table keeps its placeholder").toContain("table: placeholder");
});

// The entry the placeholder advertises has to lead somewhere usable: Ctrl+↵ on the EMPTY table used to
// open an editor with a zero-row grid — 10px tall, invisible. It opens a starter grid now.
test("#609: Ctrl+Enter on an empty table opens a grid someone can type into", async ({ page }) => {
  test.setTimeout(120_000);
  await openScratch(page, `empty609t-${Date.now()}`);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.evaluate(() => {
    const el = document.querySelector("[data-pane=preview] .cm-content") as any;
    const view = el?.cmView?.view ?? el?.cmTile?.view;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "# t\n\n:::table\n:::\n" } });
  });
  await sleep(1000);
  await page.getByTestId("macro-empty").click(); // selects the atom (the placeholder stays)
  await sleep(200);
  await page.keyboard.press("Control+Enter");
  await sleep(500);
  const editor = page.getByTestId("table-edit");
  await expect(editor, "the inline editor mounted").toBeVisible();
  const box = (await editor.boundingBox())!;
  expect(box.height, `the editor occupies real space (was a 10px sliver): ${Math.round(box.height)}px`).toBeGreaterThan(40);
  await expect(editor.locator("td, th"), "and there are cells to type into").not.toHaveCount(0);
});
