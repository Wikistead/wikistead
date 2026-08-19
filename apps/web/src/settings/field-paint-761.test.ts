// #761: two moderation screens were the only grey fields in the product.
//
// The ruling was "match the majority", and the majority is measurable: the comment box and the page
// title paint `bg-background`, the shared `Input` paints nothing (`bg-transparent`, plus a dark
// override). Grey came from two hand-written class lists nobody compared with their neighbours.
//
// This WALKS THE TREE for fields rather than listing the two that were wrong — and that mattered
// immediately: the walk found a THIRD screen (the space pages tab's filter and its move-target
// picker) that the ticket's hand sweep had missed. A list would have been green on the day a fourth
// one writes `bg-panel` into its own class string, which is exactly how these happened. What it forbids is a PANEL paint on a field; it does not dictate which of the
// two majority spellings a field uses, because `bg-background` and the shared component's
// transparency render the same over the page and the product legitimately has both.
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const webSrc = join(dirname(fileURLToPath(import.meta.url)), "..");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { out.push(...walk(p)); continue; }
    if (/\.tsx$/.test(name)) out.push(p);
  }
  return out;
}

/**
 * Every text field's own class list, read LINE BY LINE.
 *
 * ⚠️ Not by matching `<input …>` as one regex: almost every field in this tree spans several lines,
 * and a regex that tries to close the element finds only the one-liners. Measured — the first
 * version of this walk saw 9 fields and reported the tree clean. #740's report hit the same trap on
 * the same day, from the other side. So: find the element's opening line, then read forward to the
 * `className` within its attribute block.
 */
function fieldClassLists(source: string): string[] {
  const lines = source.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/<(input|textarea|select)\b/.test(lines[i]!)) continue;
    for (let j = i; j < Math.min(i + 8, lines.length); j++) {
      const cls = /className=(?:"([^"]*)"|\{`([^`]*)`\})/.exec(lines[j]!);
      if (cls) { out.push(cls[1] ?? cls[2] ?? ""); break; }
      if (/\/>|>\s*$/.test(lines[j]!) && j > i) break; // the element closed without one
    }
  }
  return out;
}

describe("#761: a text field is not painted like a panel", () => {
  const files = walk(webSrc);

  it("the walk finds fields at all (an empty walk is a broken pin, not a clean tree)", () => {
    const total = files.reduce((n, f) => n + fieldClassLists(readFileSync(f, "utf8")).length, 0);
    expect(total, "no <input>/<textarea>/<select> with a class list was found — the matcher stopped working").toBeGreaterThan(10);
  });

  it("no field carries a panel background", () => {
    const offenders: string[] = [];
    for (const f of files) {
      for (const cls of fieldClassLists(readFileSync(f, "utf8"))) {
        // `hover:bg-panel-2` and friends are STATES, not the resting paint the ruling is about.
        const resting = cls.split(/\s+/).filter((c) => !c.includes(":"));
        if (resting.some((c) => /^bg-panel(-\d)?$/.test(c))) {
          offenders.push(`${f.slice(webSrc.length + 1)}: ${cls}`);
        }
      }
    }
    expect(
      offenders,
      `a field painted like a surface (#761: the majority is bg-background / the shared Input's transparency):\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
