import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

// #639 (user ruling, 2026-08-06): administrative lists separate their rows with a LINE. A row is not its
// own box.
//
// The sweep asks the property rather than naming the five screens the ruling found: any row that draws a
// rounded border is the defect, so a sixth written next month fails the day it lands. Naming today's five
// would pass while the idiom kept spreading — which is exactly how it spread, four of them carrying the
// same class string character for character.
//
// Exclusions are declared PER LINE, never per file. #578 shipped a file-level exemption and it meant one
// annotation excused every line beneath it; the ticket calls that out by name. The four kinds of box the
// ruling protects (a section's frame, a dropdown's option, a radio card, a badge) each say so where they
// are written.
const MARKER = "list-box-ok:";

const SRC = resolve(import.meta.dirname, "..");

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = resolve(dir, name);
    if (statSync(p).isDirectory()) out.push(...tsxFiles(p));
    else if (name.endsWith(".tsx")) out.push(p);
  }
  return out;
}

/** Rows — the elements a `.map()` produces — that draw themselves as a box.
 *
 *  Narrowed to rows on purpose. "Has a rounded border" alone matches 224 lines in these two directories:
 *  section frames, dialogs, inputs, buttons, badges. Those are not what the ruling is about, and asking
 *  each of them for an annotation would turn the sweep into paperwork nobody reads — the failure mode
 *  #632 recorded when a loose predicate returned nine false positives.
 *
 *  So the shape is: a `.map(` callback, and the first element it opens. That IS a row, whatever the
 *  screen calls it, and it is the one place the boxed look belongs to this ruling. */
function boxedRows(text: string): { line: number; text: string }[] {
  const lines = text.split("\n");
  const out: { line: number; text: string }[] = [];
  lines.forEach((line, i) => {
    if (!/\.map\(/.test(line)) return;
    // the element the callback opens, within the few lines a callback's head occupies
    for (let j = i; j < Math.min(i + 6, lines.length); j++) {
      const cur = lines[j]!;
      // the FIRST element the callback opens, with or without a className — a row rendered through a
      // component carries no class string of its own, and skipping past it would land on whatever badge
      // or pill sits inside the row instead
      if (!/<[A-Za-z]/.test(cur)) continue;
      if (cur.includes(MARKER)) return;
      const rounded = /\brounded(-[a-z0-9]+)?\b/.test(cur);
      // a directional rule (`border-b`) is the separator this ruling asks FOR; `border-none` is no border
      const framed = /\bborder\b(?!-b\b)(?!-t\b)(?!-l\b)(?!-r\b)(?!-none\b)/.test(cur);
      if (rounded && framed) out.push({ line: j + 1, text: cur.trim().slice(0, 110) });
      return; // only the first element of the callback is the row
    }
  });
  return out;
}

describe("#639: an administrative list separates its rows with a line", () => {
  const files = tsxFiles(resolve(SRC, "settings")).concat(tsxFiles(resolve(SRC, "ui")));

  it("the sweep reaches real screens (a broken walk must not pass vacuously)", () => {
    expect(files.length, "settings and ui screens found").toBeGreaterThan(20);
    // …and there are boxes to find, so the marker is doing work rather than the walk finding nothing
    const marked = files.filter((f) => readFileSync(f, "utf8").includes(MARKER));
    expect(marked.length, `screens that declare a deliberate box: ${marked.length}`).toBeGreaterThan(0);
  });

  it("no row is drawn as its own box", () => {
    const found: string[] = [];
    for (const f of files) {
      for (const hit of boxedRows(readFileSync(f, "utf8"))) {
        found.push(`${f.slice(SRC.length + 1)}:${hit.line}  ${hit.text}`);
      }
    }
    expect(found, `boxed rows (annotate a deliberate one with "${MARKER} <why>" ON ITS LINE):\n${found.join("\n")}`)
      .toEqual([]);
  });

  it("the row itself comes from one component, not from a class string each screen repeats", () => {
    // the copied idiom, in the exact shape it was spread in
    const copied = files.filter((f) =>
      readFileSync(f, "utf8").split("\n").some((l) =>
        /class(Name)?=/.test(l) && /gap-2\.5 rounded-md border border-border px-2\.5 py-2/.test(l)));
    expect(copied.map((f) => f.slice(SRC.length + 1)), "the boxed-row idiom is gone from every screen").toEqual([]);
    // and the component exists to have replaced it
    expect(readFileSync(resolve(SRC, "ui/list-rows.tsx"), "utf8")).toMatch(/border-b border-border/);
  });

  it("a list grows with its content and scrolls only once it is tall", () => {
    // A fixed height gives a two-item list a mostly-empty frame — the ruling: no box drawn by default.
    // Only lists are checked: `h-` is ordinary on an icon, an avatar, a spinner.
    const fixed: string[] = [];
    for (const f of files) {
      readFileSync(f, "utf8").split("\n").forEach((line, i) => {
        if (!/overflow-y-auto/.test(line)) return;
        // a FIXED height, not `max-h-` / `min-h-`: the token boundary alone matches inside those, and
        // `max-h-[26rem]` is the very idiom this ruling asks for
        if (!/(?<![a-z-])h-\[|(?<![a-z-])h-\d/.test(line)) return;
        fixed.push(`${f.slice(SRC.length + 1)}:${i + 1}  ${line.trim().slice(0, 110)}`);
      });
    }
    expect(fixed, `a scrolling list with a fixed height shows an empty frame when it is short:\n${fixed.join("\n")}`)
      .toEqual([]);
  });
});
