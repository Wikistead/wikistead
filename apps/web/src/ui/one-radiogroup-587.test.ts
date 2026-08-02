// #587: one single-select control, not five.
//
// The user asked why the role-scope choice did not look like the theme choice. The answer was that
// #580 built it by hand — and then had to add roving tabindex and arrow keys by hand as well, one
// review later, both of which the DS component has carried since #389. Two more surfaces had
// done the same: the display-mode pill (no arrow keys at all, every segment at tabIndex 0) and the
// graph-depth picker.
//
// So this is a DISCOVERY pin over the source: anything claiming `role="radiogroup"` outside the DS is
// a re-run of that mistake. The one exception is AccentPicker, where the options ARE colour swatches
// rather than labels — none of the DS's three variants describes it, and pretending otherwise would
// be worse than the exception. It is named here, so adding a second exception is a decision someone
// has to write down rather than a thing that quietly happens.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const SRC = resolve(import.meta.dirname, "..");

/** Files allowed to speak radiogroup: the DS itself, its Radix layer, and the swatch picker. */
const ALLOWED = [
  "ui/RadioGroup.tsx",
  "components/ui/radio-group.tsx",
  "settings/AccentPicker.tsx",
];

const sources = (): string[] => {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(p) && !/\.(test|spec)\./.test(p)) out.push(p);
    }
  };
  walk(SRC);
  return out;
};

describe("#587: the single-select control lives in the DS", () => {
  it("no surface hand-rolls a radiogroup", () => {
    const offenders = sources()
      .filter((f) => /role="radiogroup"|role: "radiogroup"/.test(readFileSync(f, "utf8")))
      .map((f) => f.slice(SRC.length + 1))
      .filter((rel) => !ALLOWED.includes(rel));
    expect(offenders, "use <RadioGroup> from ui/RadioGroup — it brings arrow keys and roving focus").toEqual([]);
  });

  it("the scan is looking at the whole app (guard against a vacuous pass)", () => {
    expect(sources().length).toBeGreaterThan(100);
    // and the allow-list is not a list of files that no longer exist
    for (const rel of ALLOWED) expect(() => readFileSync(join(SRC, rel), "utf8"), rel).not.toThrow();
  });

  it("the DS keeps the keyboard behaviour the hand-rolled ones lacked", () => {
    const src = readFileSync(join(SRC, "ui/RadioGroup.tsx"), "utf8");
    // the arrow-key fix: the flag is set in the CAPTURE phase (before Radix moves focus) and consumed
    // by the focus it caused. Clearing it on keyup is what broke the first press — do not put it back.
    expect(src).toMatch(/onKeyDownCapture/);
    expect(src, "keyup clears too early: Radix focuses from an effect, after the key is up").not.toMatch(/onKeyUpCapture/);
    expect(src).toMatch(/arrowKey\.current = false; \/\/ consumed/);
  });

  it("the segmented selection cue is the accent fill, with no glyph (#587 ruling)", () => {
    const src = readFileSync(join(SRC, "ui/RadioGroup.tsx"), "utf8");
    expect(src).toMatch(/data-\[state=checked\]:bg-primary/);
    expect(src, "the Check glyph is gone — ADR-146's clause was updated, not broken silently").not.toMatch(/<Check\b/);
    // the list/card variants keep their dot: those rows are not filled, so there colour WOULD be alone
    expect(src).toMatch(/wks-radio-ring/);
  });
});
