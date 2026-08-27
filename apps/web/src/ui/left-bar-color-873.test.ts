// #873 (review rejection): a band that wears `wks-left-bar` has to say what colour the strip is.
//
// THE DEFECT: `UnsavedBanner` set the class and nothing else, so the strip took the rule's default —
// `var(--wks-left-bar-color, var(--accent))`, blue. Its own border was already `--danger` and its own
// comment said the strip was too. The band shipped looking like ordinary information while announcing
// that edits were not reaching the server.
//
// ⚠️ WHY A TEST AND NOT A REVIEW: the near-miss on this same component was a MISTYPED token, and that
// one is self-announcing — Tailwind drops a class it cannot resolve and the strip vanishes, so the
// first look catches it. An UNSTATED token fails the other way: the default paints a strip that looks
// deliberate. The two mistakes are one keystroke apart and only one of them is visible.
//
// The scan is a discovery: it judges every element carrying the class, so a band written next month is
// measured the day it appears rather than the day somebody compares it to this one.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const SRC = resolve(import.meta.dirname, "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx$/.test(name) && !/\.test\.tsx$/.test(name)) out.push(full);
  }
  return out;
}

/**
 * Every className string in the tree that carries the class, with the lines immediately around it.
 *
 * The window is the ELEMENT, not the file: a `style` prop three lines down belongs to this band, and
 * one in a different band forty lines away does not. Reading the whole file would let a neighbour's
 * colour excuse a band that states none — which is the exact shape of the defect.
 */
function leftBarSites(): { where: string; className: string; near: string }[] {
  const sites: { where: string; className: string; near: string }[] = [];
  for (const path of walk(SRC)) {
    const lines = readFileSync(path, "utf8").split("\n");
    lines.forEach((line, i) => {
      const m = line.match(/className="([^"]*\bwks-left-bar\b[^"]*)"/);
      if (m) sites.push({
        where: `${relative(SRC, path)}:${i + 1}`,
        className: m[1]!,
        near: lines.slice(Math.max(0, i - 3), i + 4).join("\n"),
      });
    });
  }
  return sites;
}

describe("#873 a left-bar band names its own colour", () => {
  const sites = leftBarSites();

  it("finds the bands at all — a scan of nothing would satisfy every assertion below", () => {
    // Measured today: six (#978 retired UnsavedBanner's, the seventh, in favour of a toast). The
    // number is asserted loosely on purpose (bands come and go), but zero and one are the states
    // where this file would be reporting on a tree it never read.
    expect(sites.length, "no wks-left-bar element found — the walk is measuring nothing").toBeGreaterThan(4);
  });

  it.each(sites.map((s) => [s.where, s.className, s.near] as const))(
    "%s states --wks-left-bar-color",
    (where, className, near) => {
      // Two spellings are in use and both are explicit: the Tailwind arbitrary property in the class
      // list, and a `style` prop on the same element (AdminAuthTab). Either answers the question.
      const inClass = /\[--wks-left-bar-color:/.test(className);
      const inStyle = /"--wks-left-bar-color"\s*:/.test(near);
      expect(
        inClass || inStyle,
        `${where} wears wks-left-bar without saying its colour, so it takes the rule's default ` +
        `(var(--accent), blue). Name the token — a band nobody chose a colour for still renders.`,
      ).toBe(true);
    },
  );
});
