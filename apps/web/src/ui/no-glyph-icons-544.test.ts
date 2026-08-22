// @vitest-environment node
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

// #544 anti-drift (the #256 family): a control icon drawn as a TEXT glyph (✎ × ✕ ⤓ …) renders at the
// mercy of the platform's font fallback — the reported pencil was an unreadable smudge. Icons are Lucide
// components on the React side and trusted constant SVGs (md-render's ICON_*) on the DOM side. This pin
// stops the next glyph button from slipping back in, one control at a time (the no-native-title shape
// a grep pin whose exception list is REVIEWED, not a dumping ground).
const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(here, "..");

// DISCOVERY, not enumeration: the first pin listed the eight glyphs already found — so the
// NEXT glyph (⠿ ↩ ⤢, and whatever comes after) sailed through, which is the exact "the user finds
// occurrence N+1" loop this ticket exists to end. The position filter (a lone 1-2 char glyph as a JSX
// child, or assigned to textContent) is what keeps "any non-ASCII" from flagging prose/i18n — measured
// it matches icon sites and nothing else in this tree.
const ICON_SHAPED = [
  />\s*[^\x00-\x7f]{1,2}\s*</,
  /textContent\s*=\s*["'][^\x00-\x7f]{1,2}["']/,
];

// REVIEWED exceptions, matched on the source line — a new glyph in the same file still fails.
const ALLOWED_LINE = [
  // decorations.ts details arrow: ONE glyph whose open state is a pure CSS rotation (no text swap)
  // swapping it for an SVG would change the rotation contract for no rendering gain (▸ is in the
  // monospace fonts the editor ships).
  /cm-lp-details-arrow|arrow\.textContent = "▸"/,
  // decorations.ts layout (add column/tab): a FULL-WIDTH plus chosen in #278 whose metrics are part
  // of the layout affordance's measured width (the 315→336px reflow pins) — and it ships in the
  // editor's own fonts, so the font-fallback failure this pin guards against does not apply to it.
  /add\.textContent = "＋"/,
  // SpacePagesTab move-target placeholder: an <option> element can only render TEXT (no SVG child
  // exists in the options tree), and the em-dash is typography ("no selection"), not a control icon.
  /<option value="">—<\/option>/,
  /^\s*\/\/|^\s*\*|^\s*\/\*/, // comments (including this file's own prose)
];

function* walk(dir: string): Generator<string> {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === "dist" || e === "__snapshots__") continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(ts|tsx)$/.test(p) && !/\.(test|spec)\.tsx?$/.test(p)) yield p;
  }
}

describe("#544: no text-glyph icons in app code", () => {
  // #892: the case below asserts that the scan found NO offenders, which is also what a scan that ran
  // over nothing reports. Measured on 2026-08-22: pointing the walk at an empty directory left this
  // file green. A pin whose walk has stopped walking reads as coverage while checking nothing.
  it("scanned the source at all", () => {
    const files = [...walk(srcRoot)];
    expect(files.length, `no sources found under ${srcRoot}`).toBeGreaterThanOrEqual(100);
    expect(files.some((f) => f.endsWith("Button.tsx")), "a known source file was not reached").toBe(true);
  });

  it("every control icon is a Lucide component (React) or a trusted constant SVG (DOM)", () => {
    const offenders: string[] = [];
    for (const file of walk(srcRoot)) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (!ICON_SHAPED.some((re) => re.test(line))) return;
        if (ALLOWED_LINE.some((re) => re.test(line))) return;
        offenders.push(`${relative(srcRoot, file)}:${i + 1}: ${line.trim().slice(0, 120)}`);
      });
    }
    expect(
      offenders,
      `text-glyph icons found — use lucide-react (React) or an ICON_* trusted constant SVG (DOM), or add a REVIEWED exception:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
