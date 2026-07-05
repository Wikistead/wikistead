import { describe, it, expect } from "vitest"
import { EditorState } from "@codemirror/state"
import { markdownExtension } from "../markdown-config"
import { blockRangeAt, computeBlockMove } from "./block-move"

const mk = (doc: string) => EditorState.create({ doc, extensions: [markdownExtension()] })
// Move the block containing `pos` to before the block starting at line `targetLine`
// (or to end when targetLine is null). Returns the resulting doc.
function move(doc: string, pos: number, targetLine: number | null): string {
  const state = mk(doc)
  const src = blockRangeAt(state, pos)!
  const target = targetLine == null ? state.doc.length : state.doc.line(targetLine).from
  const res = computeBlockMove(state.doc, src, target)
  return res ? state.update({ changes: res.changes }).state.doc.toString() : doc
}
const nlCount = (s: string) => (s.match(/\n/g) ?? []).length

describe("blockRangeAt (#84)", () => {
  it("spans a whole pipe table atom (fence never split)", () => {
    const doc = "intro\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\nout"
    const s = mk(doc)
    const r = blockRangeAt(s, s.doc.line(4).from)!
    expect(s.doc.sliceString(r.from, r.to)).toBe("| A | B |\n| --- | --- |\n| 1 | 2 |")
  })
  it("returns null on a blank line", () => {
    const s = mk("a\n\nb")
    expect(blockRangeAt(s, s.doc.line(2).from)).toBeNull()
  })
})

// Approved rule (#84): a block owns its TRAILING separator. Three blocks A/B/C each separated
// by one blank line: "A\n\nB\n\nC".
describe("computeBlockMove — block owns trailing separator (#84)", () => {
  it("moves the FIRST block down to before the last (A before C)", () => {
    // move A (line 1) to before C (line 5): B, then A, then C — single blanks preserved
    expect(move("A\n\nB\n\nC", 0, 5)).toBe("B\n\nA\n\nC")
  })

  it("moves a MIDDLE block up to the top (B before A)", () => {
    const s = mk("A\n\nB\n\nC")
    expect(move("A\n\nB\n\nC", s.doc.line(3).from, 1)).toBe("B\n\nA\n\nC")
  })

  it("moves the FIRST block to the very end (A to end) — last-block separator synthesized", () => {
    expect(move("A\n\nB\n\nC", 0, null)).toBe("B\n\nC\n\nA")
  })

  it("moves a MIDDLE block to the very end (B to end) with no trailing blank line (#84 comment 750)", () => {
    // The end-drop appends after C even though the doc has no trailing blank line.
    const s = mk("A\n\nB\n\nC")
    expect(move("A\n\nB\n\nC", s.doc.line(3).from, null)).toBe("A\n\nC\n\nB")
  })

  it("moving the LAST block to the very end is a no-op (already last)", () => {
    const s = mk("A\n\nB\n\nC")
    expect(computeBlockMove(s.doc, blockRangeAt(s, s.doc.line(5).from)!, s.doc.length)).toBeNull()
  })

  it("moves the LAST block up to the top (C before A) — leading separator reclaimed", () => {
    const s = mk("A\n\nB\n\nC")
    expect(move("A\n\nB\n\nC", s.doc.line(5).from, 1)).toBe("C\n\nA\n\nB")
  })

  it("preserves blank-line count at the seams (no multiply / vanish)", () => {
    const before = "A\n\nB\n\nC"
    for (const out of [move(before, 0, 5), move(before, 0, null), move(before, mk(before).doc.line(5).from, 1)]) {
      expect(nlCount(out)).toBe(nlCount(before))
    }
  })

  it("moves a whole table atom without splitting it", () => {
    const doc = "| A | B |\n| --- | --- |\n| 1 | 2 |\n\npara\n\ntail"
    const s = mk(doc)
    const tbl = blockRangeAt(s, s.doc.line(2).from)!
    const res = computeBlockMove(s.doc, tbl, s.doc.line(7).from)! // before "tail"
    const out = s.update({ changes: res.changes }).state.doc.toString()
    expect(out).toContain("| A | B |\n| --- | --- |\n| 1 | 2 |") // intact
    expect(out.indexOf("para")).toBeLessThan(out.indexOf("| A | B |")) // table now after para
  })

  it("is one changeset (one dispatch ⇒ one Yjs transaction)", () => {
    const s = mk("A\n\nB\n\nC")
    const res = computeBlockMove(s.doc, blockRangeAt(s, 0)!, s.doc.line(5).from)!
    expect(Array.isArray(res.changes)).toBe(true)
  })

  it("no-op when dropping a block onto itself", () => {
    const s = mk("A\n\nB")
    expect(computeBlockMove(s.doc, blockRangeAt(s, 0)!, s.doc.line(1).from)).toBeNull()
  })
})
