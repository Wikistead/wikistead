// #623 slice 10: the surfaces whose SERVER bound landed in slice 4, and whose container waited for #639.
//
// Written as a walk rather than as five rows. `bounded-lists-539` keeps a named list and says so — "adding
// a growing list to this family means adding a row here" — and that instruction has been missed once
// already (the fourth instance was skipped by the very fix that promised it). So this asks the
// question the other way round: find every surface that renders a list of rows, and require it to be
// inside the shared box. A sixth one written next month is covered by existing.
//
// Lexical, because happy-dom has no layout engine — whether the box LOOKS right is a review. What
// is checked here is that the markup routes through the one component, which is where the height lives.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const WEB = resolve(import.meta.dirname, "..");

function tsx(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = resolve(dir, e.name);
    if (e.isDirectory()) return e.name === "node_modules" ? [] : tsx(p);
    return e.name.endsWith(".tsx") ? [p] : [];
  });
}

/** A surface that draws rows from data: a `.map(` whose body opens a row element with its own testid. */
const ROW_MAP = /\.map\(\([^)]*\)\s*=>\s*\(?\s*<(?:li|tr)\b[^>]*data-testid="([a-z0-9-]*row[a-z0-9-]*)"/g;

describe("#623: a surface that lists rows puts them in the shared box", () => {
  it("the walk finds row-rendering surfaces (a broken pattern must not pass by finding none)", () => {
    const hits = tsx(WEB).filter((f) => ROW_MAP.test(readFileSync(f, "utf8")));
    ROW_MAP.lastIndex = 0;
    expect(hits.length, "surfaces that draw rows from data").toBeGreaterThan(3);
  });

  it("each of them is inside a ListBox", () => {
    const missing: string[] = [];
    for (const file of tsx(WEB)) {
      const src = readFileSync(file, "utf8");
      ROW_MAP.lastIndex = 0;
      if (!ROW_MAP.test(src)) continue;
      ROW_MAP.lastIndex = 0;
      // BOUNDED, not "uses the component". The walk found two surfaces that carry the cap as literal
      // classes — the audit ledger (#503, which predates the shared box) and the space page list (this
      // ticket's own slice 1, written before #639 landed). Both scroll inside a fixed height, which is
      // the property that matters; demanding the component would have failed them for a spelling.
      const boxed = /<ListBox\b/.test(src) || (/max-h-\[/.test(src) && /overflow-y-auto/.test(src));
      if (!boxed) missing.push(file.slice(WEB.length + 1));
    }
    expect(missing, `these draw rows with nothing bounding them :: ${missing.join(", ")}`).toEqual([]);
  });
});
