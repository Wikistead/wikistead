import { describe, it, expect } from "vitest";
import { atomMotionTarget, motionAtomsForCaret } from "./decorations";

// #183 symptom C: j/k vertical motion around atoms must be ONE line, SYMMETRIC in both directions,
// and never skip a line — including when an atom sits at EOF/BOF (where CM can't land on a line PAST
// the atom, so it lands INSIDE it). atomMotionTarget is the pure decision; tested with distinct line
// layouts so the redirect is a real boundary, not a constant.
const atom = (first: number, last: number) => ({ first, last });

describe("atomMotionTarget (#183 atom vertical motion)", () => {
  it("SYMPTOM C (down, atom at EOF): stepping into an atom CM can't pass lands on its FIRST line", () => {
    // lines 5-6 = a code-fence atom at EOF; from line 4 (first-1) j — CM can't reach line 7, lands
    // INSIDE (6). Old code needed newLine>=7 and missed this → caret stuck on 6, skipping 5.
    expect(atomMotionTarget(4, 6, 1, [atom(5, 6)], 6)).toBe(5);
  });
  it("SYMPTOM C (up, atom at BOF): stepping up into an atom CM can't pass lands on its LAST line", () => {
    expect(atomMotionTarget(3, 1, -1, [atom(1, 2)], 6)).toBe(2);
  });

  it("down onto an atom that CM overshot PAST → its first line (unchanged case)", () => {
    expect(atomMotionTarget(2, 4, 1, [atom(3, 3)], 6)).toBe(3);
  });
  it("up onto an atom that CM overshot PAST → its last line (unchanged case)", () => {
    expect(atomMotionTarget(4, 2, -1, [atom(3, 3)], 6)).toBe(3);
  });

  it("on an atom → steps OFF one line (down→last+1, up→first-1) — one stop", () => {
    expect(atomMotionTarget(3, 4, 1, [atom(3, 3)], 6)).toBe(4);
    expect(atomMotionTarget(3, 2, -1, [atom(3, 3)], 6)).toBe(2);
  });
  it("on an atom at EOF with no line to step to → null (leave as-is)", () => {
    expect(atomMotionTarget(6, 6, 1, [atom(5, 6)], 6)).toBeNull();
  });

  it("down/up onto the same atom are SYMMETRIC (near-edge each way)", () => {
    const a = [atom(3, 4)];
    expect(atomMotionTarget(2, 3, 1, a, 8)).toBe(3);  // from above → first
    expect(atomMotionTarget(5, 4, -1, a, 8)).toBe(4); // from below → last
  });

  it("overshoot clamp: a tall atom strictly crossed (caret not on it) → the adjacent line", () => {
    expect(atomMotionTarget(2, 6, 1, [atom(3, 4)], 8)).toBe(3); // crossed [3,4] from 2→6 → clamp to 3
  });

  it("no atom involved → null (normal line motion untouched)", () => {
    expect(atomMotionTarget(1, 2, 1, [atom(5, 6)], 6)).toBeNull();
  });
});

// #141 bounce (comment 651): motion atoms must EXCLUDE a block the caret is editing inside (revealed
// raw source → line-by-line, not a cross-atom), but KEEP collapsed atoms (the caret only ever sits at
// their edge). motionAtomsForCaret is that filter — the guard against j/k warping across the fences of
// a directive block whose body is being edited.
describe("motionAtomsForCaret (#141 revealed block is not a cross-atom)", () => {
  const block = (from: number, to: number) => ({ from, to });

  it("DROPS a block the caret sits strictly inside (revealed → line-by-line motion)", () => {
    // block spans offsets 4..20; caret at 10 is strictly inside → excluded so j/k steps line by line
    expect(motionAtomsForCaret([block(4, 20)], 10)).toEqual([]);
  });

  it("KEEPS a block whose caret is at its START edge (collapsed atom → still crossed in one step)", () => {
    // a collapsed atomic widget only ever holds the caret at `from` (never interior) → kept
    expect(motionAtomsForCaret([block(4, 20)], 4)).toEqual([block(4, 20)]);
  });

  it("KEEPS a block whose caret is at its END edge", () => {
    expect(motionAtomsForCaret([block(4, 20)], 20)).toEqual([block(4, 20)]);
  });

  it("KEEPS a block the caret is entirely outside", () => {
    expect(motionAtomsForCaret([block(4, 20)], 30)).toEqual([block(4, 20)]);
  });

  it("filters only the entered block, keeping the others (mixed set)", () => {
    const bs = [block(0, 5), block(10, 30), block(40, 45)];
    // caret inside the middle block → only it drops; the others (collapsed) stay motion atoms
    expect(motionAtomsForCaret(bs, 20)).toEqual([block(0, 5), block(40, 45)]);
  });
});
