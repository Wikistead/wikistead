import { test, expect } from "@playwright/test";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { openScratch, enterEdit, sleep } from "../helpers";

// #455, re-pinned by #600's bounce: an EMPTY macro shows a placeholder, and a placeholder is FULL WIDTH.
//
// `:::table{align=center}` shrank its dashed box to the width of its own sentence while every other empty
// macro stayed full width. The rule was written twice, four lines apart, and the copy added later (#393,
// table alignment) left the empty check out. #455's pin only ever looked at diagrams, so the second copy
// was free to be wrong.
//
// This pin is therefore aimed at the RULE rather than at table: it discovers the macros from the registry
// source, writes each one empty and centred, and asserts that NO empty macro carries an align class and
// that every one of them is as wide as the text column. A macro that gains alignment tomorrow is measured
// by existing.
//
// Real browser, because both halves are geometry: a class alone would not prove the box is full width,
// and the reject was a screenshot of a narrow box.
const MACRO_DIR = resolve(import.meta.dirname, "../../../apps/web/src/editor/macros");

/** The registry, read from source — a new macro appears here without this file being edited (#544). */
function discoverMacros(): { kind: "fence" | "directive"; name: string }[] {
  const found = new Map<string, { kind: "fence" | "directive"; name: string }>();
  for (const file of readdirSync(MACRO_DIR).filter((f) => f.endsWith(".ts") && !f.includes(".test."))) {
    const src = readFileSync(join(MACRO_DIR, file), "utf8");
    for (const m of src.matchAll(/kind:\s*"fence"[\s\S]{0,200}?lang:\s*"([a-z0-9-]+)"/g)) found.set(`f:${m[1]}`, { kind: "fence", name: m[1]! });
    for (const m of src.matchAll(/kind:\s*"directive"[\s\S]{0,200}?name:\s*"([a-z0-9-]+)"/g)) found.set(`d:${m[1]}`, { kind: "directive", name: m[1]! });
  }
  return [...found.values()];
}

// Every macro, empty, and asked for the alignment that caused the reject.
const emptyDoc = (): string =>
  discoverMacros()
    .map((m) => (m.kind === "fence" ? "```" + m.name + " align=center\n```" : `:::${m.name}{align=center}\n:::`))
    .join("\n\n") + "\n";

const REFERENCE = "reference line\n\n";

test("#455/#600: an empty macro is never aligned, whatever macro it is", async ({ page }) => {
  test.setTimeout(120_000);
  const macros = discoverMacros();
  expect(macros.length, "the discovery found the registry (a pin over an empty set proves nothing)").toBeGreaterThan(10);

  await openScratch(page, `empty-align-${Date.now()}`);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.evaluate((text) => {
    const el = document.querySelector("[data-pane=preview] .cm-content") as { cmView?: { view?: unknown }; cmTile?: { view?: unknown } } | null;
    const view = (el?.cmView?.view ?? el?.cmTile?.view) as { state: { doc: { length: number } }; dispatch(t: unknown): void } | undefined;
    if (!view) throw new Error("no editor view");
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
  }, REFERENCE + emptyDoc());
  await sleep(1500);

  const measured = await page.evaluate(() => {
    const content = document.querySelector("[data-pane=preview] .cm-content") as HTMLElement;
    // The baseline is a PLAIN LINE of prose, not the scroller: the content element carries padding, so
    // measuring against it would call every block narrow. "Full width" means "as wide as a paragraph".
    const ref = [...content.querySelectorAll<HTMLElement>(".cm-line")].find((l) => (l.textContent ?? "").includes("reference line"));
    const column = ref ? ref.getBoundingClientRect().width : content.getBoundingClientRect().width;
    // Every macro block in the document is empty, so every wrap here IS a placeholder — no need to
    // recognise particular macros, which is what made the last pin miss the one that was wrong.
    return {
      column,
      wraps: [...content.querySelectorAll<HTMLElement>(".cm-lp-macro-wrap")].map((w) => ({
        classes: [...w.classList].filter((c) => c.startsWith("cm-lp-align-")),
        width: w.getBoundingClientRect().width,
        text: (w.textContent ?? "").slice(0, 40),
      })),
    };
  });

  expect(measured.wraps.length, "the document rendered its macro blocks").toBeGreaterThan(5);
  const aligned = measured.wraps.filter((w) => w.classes.length > 0);
  expect(aligned, "an empty macro carries no align class").toEqual([]);
  // and the class is not the only way to shrink a box — measure the box itself
  const narrow = measured.wraps.filter((w) => w.width < measured.column - 24);
  expect(narrow.map((w) => `${w.text} @${Math.round(w.width)}/${Math.round(measured.column)}`), "an empty macro's placeholder spans the text column").toEqual([]);
});

test("#255/#393: a macro WITH content still aligns (the empty rule takes nothing away)", async ({ page }) => {
  test.setTimeout(120_000);
  await openScratch(page, `filled-align-${Date.now()}`);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.evaluate(() => {
    const el = document.querySelector("[data-pane=preview] .cm-content") as { cmView?: { view?: unknown }; cmTile?: { view?: unknown } } | null;
    const view = (el?.cmView?.view ?? el?.cmTile?.view) as { state: { doc: { length: number } }; dispatch(t: unknown): void } | undefined;
    if (!view) throw new Error("no editor view");
    const doc = ":::table{align=center}\n<table><tr><td>one</td></tr></table>\n:::\n\n```mermaid align=right\ngraph TD\n  a-->b\n```\n";
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: doc } });
  });
  await sleep(2000);

  const classes = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("[data-pane=preview] .cm-lp-macro-wrap")].map((w) => [...w.classList].filter((c) => c.startsWith("cm-lp-align-"))),
  );
  expect(classes.filter((c) => c.includes("cm-lp-align-center")).length, "the filled table centres").toBe(1);
  expect(classes.filter((c) => c.includes("cm-lp-align-right")).length, "the filled diagram goes right").toBe(1);
});
