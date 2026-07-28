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

// The glyphs that have actually been used as icons in this codebase. Deliberately NOT "any non-ASCII"
// prose, i18n strings and test fixtures are full of legitimate unicode.
const GLYPHS = "✎✕⤓✗◐×▸＋";

// An icon-shaped use: a lone glyph as a JSX child, or assigned to textContent.
const ICON_SHAPED = [
  new RegExp(`>\\s*[${GLYPHS}]\\s*<`),
  new RegExp(`textContent\\s*=\\s*["'][${GLYPHS}]["']`),
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
