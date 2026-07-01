import { describe, it, expect } from "vitest";
import { atomBlockAtCaret, atomOpenLineTarget } from "./vim-atom";

// #183 symptom B / o-O: plain o/O on an atom opens a new line AFTER (o) / BEFORE (O) the WHOLE atom,
// never inside it. Pure offset math (lineAt mocked to the atom's first/last line bounds).
describe("atomOpenLineTarget (#183 o/O on an atom)", () => {
  // atom spans [10,30]; its first line is [8,15], its last line is [25,33].
  const lineAt = (p: number) => (p === 30 ? { from: 25, to: 33 } : p === 10 ? { from: 8, to: 15 } : { from: p, to: p });
  it("o opens BELOW the whole atom (at the last line's end), caret on the new line", () => {
    expect(atomOpenLineTarget({ from: 10, to: 30 }, "o", lineAt)).toEqual({ insertAt: 33, caret: 34 });
  });
  it("O opens ABOVE the whole atom (at the first line's start), caret on the new line", () => {
    expect(atomOpenLineTarget({ from: 10, to: 30 }, "O", lineAt)).toEqual({ insertAt: 8, caret: 8 });
  });
});

// #91 atom-direction bug: yy/dd must grab the WHOLE atom regardless of which line the caret
// entered on. Entering from below lands the caret on the atom's LAST line — the old "caret on the
// atom's first line" check missed that, so yy/dd fell back to vim's 1-line version (yy yanked just
// `:::`, p pasted an empty macro). atomBlockAtCaret resolves the containing atom by source RANGE.
//
// Model a multi-line atom whose source is lines [from .. to]. E.g. a 3-line `:::table` directive:
//   :::table        ← line 1 (from)
//   | a | b |       ← line 2 (middle)
//   :::             ← line 3 (to is the last char of this line)
const atom = { from: 10, to: 30 }; // an atom spanning offsets 10..30 (multi-line in the doc)

describe("atomBlockAtCaret (#91 entry-direction independence)", () => {
  it("matches when the caret is on the atom's FIRST line (entered from above)", () => {
    expect(atomBlockAtCaret([atom], atom.from)).toEqual(atom);
  });

  it("matches when the caret is on the atom's LAST line (entered from below) — the direction bug", () => {
    // This is the regression: caret at the end of the atom (last `:::` line) used to miss because
    // the old check compared only against the FIRST line. Range containment fixes it.
    expect(atomBlockAtCaret([atom], atom.to)).toEqual(atom);
    expect(atomBlockAtCaret([atom], atom.to - 1)).toEqual(atom); // anywhere on the last line
  });

  it("matches when the caret is on a MIDDLE line of a multi-line atom", () => {
    expect(atomBlockAtCaret([atom], 20)).toEqual(atom);
  });

  it("does NOT match a caret BEFORE the atom (normal line above)", () => {
    expect(atomBlockAtCaret([atom], atom.from - 1)).toBeNull();
  });

  it("does NOT match a caret AFTER the atom (normal line below)", () => {
    expect(atomBlockAtCaret([atom], atom.to + 1)).toBeNull();
  });

  it("resolves the correct atom when several are present (caret inside the second)", () => {
    const a = { from: 0, to: 5 };
    const b = { from: 12, to: 40 };
    expect(atomBlockAtCaret([a, b], 25)).toEqual(b);
    expect(atomBlockAtCaret([a, b], 3)).toEqual(a);
    expect(atomBlockAtCaret([a, b], 8)).toBeNull(); // the gap between two atoms (a normal line)
  });

  it("returns null when there are no atoms (or the field is absent)", () => {
    expect(atomBlockAtCaret([], 10)).toBeNull();
    expect(atomBlockAtCaret(undefined, 10)).toBeNull();
  });
});
