// Block drag-to-reorder core (ADR-036 / #84). Pure CodeMirror-state logic, no DOM. A move is
// ONE transaction (= one Yjs op via yCollab). Approved separator rule (#84): a block OWNS its
// trailing blank-line separator. Moving cuts [block.from, nextBlock.from) (the block + the
// blanks after it) and inserts it before the target block; the last block has no trailing
// separator, so on remove we reclaim its LEADING separator and on insert we synthesize one.
// Only the two move boundaries are re-normalized — never other whitespace.
import type { EditorState, ChangeSpec, Text } from "@codemirror/state"
import { syntaxTree } from "@codemirror/language"

export interface BlockRange { from: number; to: number } // line-aligned source offsets (no trailing \n)

// The top-level block (paragraph, heading, list, blockquote, or an ATOM: table / fenced code /
// :::directive macro) whose source covers `pos`. A lezer top-level node already spans a whole
// atom, so atoms are indivisible for free. Returns null on a blank line (nothing to drag).
export function blockRangeAt(state: EditorState, pos: number): BlockRange | null {
  const doc = state.doc
  const line = doc.lineAt(pos)
  if (line.text.trim() === "") return null
  let node = syntaxTree(state).resolveInner(line.from, 1)
  while (node.parent && node.parent.parent) node = node.parent
  const nodeFrom = node.parent ? node.from : line.from
  const nodeTo = node.parent ? node.to : line.to
  const from = doc.lineAt(Math.max(0, Math.min(nodeFrom, doc.length))).from
  const to = doc.lineAt(Math.max(from, Math.min(nodeTo > nodeFrom ? nodeTo - 1 : nodeTo, doc.length))).to
  return { from, to }
}

// First content (non-blank) line at/after line number `n` (1-based); null if none.
function nextContentLineFrom(doc: Text, afterLineNo: number): number | null {
  for (let n = afterLineNo + 1; n <= doc.lines; n++) {
    if (doc.line(n).text.trim() !== "") return doc.line(n).from
  }
  return null
}
// End offset of the last content line at/before line number `n` (1-based); null if none.
function prevContentLineTo(doc: Text, beforeLineNo: number): number | null {
  for (let n = beforeLineNo - 1; n >= 1; n--) {
    if (doc.line(n).text.trim() !== "") return doc.line(n).to
  }
  return null
}
// Is there a content (non-blank) line at or after `offset`? False ⇒ the target is the end
// (an append), so the moved block needs a LEADING separator instead of a trailing one.
function hasContentAtOrAfter(doc: Text, offset: number): boolean {
  if (offset >= doc.length) return false
  for (let n = doc.lineAt(offset).number; n <= doc.lines; n++) {
    if (doc.line(n).text.trim() !== "") return true
  }
  return false
}

// Compute the single-transaction move of the block `src` to before the block starting at
// `targetLineFrom` (a line start; pass doc.length to move to the very end). Returns null for a
// no-op. `src` owns its trailing separator; newline count is preserved at the seams (blank
// lines neither multiply nor vanish), and only the two boundaries are touched.
export function computeBlockMove(
  doc: Text,
  src: BlockRange,
  targetLineFrom: number,
): { changes: ChangeSpec } | null {
  const SEP = "\n\n" // one blank line between blocks
  const blockContent = doc.sliceString(src.from, src.to) // bare block (no surrounding blanks)
  const srcLastLineNo = doc.lineAt(src.to).number
  const isLast = nextContentLineFrom(doc, srcLastLineNo) === null

  // Removal reclaims the separator the block owns, so the seam left behind stays single-blank:
  //  - non-last: cut [src.from, nextBlock.from) — the block + the blank(s) AFTER it.
  //  - last: cut [prevContentEnd, end) — the blank(s) BEFORE it + the block (no trailing sep).
  let cutFrom: number
  let cutTo: number
  if (!isLast) {
    cutFrom = src.from
    cutTo = nextContentLineFrom(doc, srcLastLineNo)!
  } else {
    cutFrom = prevContentLineTo(doc, doc.lineAt(src.from).number) ?? src.from
    cutTo = doc.length
  }
  // No-op: dropping the block onto itself / inside its own cut range.
  if (targetLineFrom >= cutFrom && targetLineFrom <= cutTo) return null

  // Insert-before a block ⇒ trailing separator (block + SEP, before the target). Append at the
  // end (no content at/after target) ⇒ leading separator (SEP + block, after the last block).
  const append = !hasContentAtOrAfter(doc, targetLineFrom)
  const insertAt = append ? doc.length : targetLineFrom
  const insertText = append ? SEP + blockContent : blockContent + SEP

  const changes: ChangeSpec =
    insertAt <= cutFrom
      ? [{ from: insertAt, insert: insertText }, { from: cutFrom, to: cutTo, insert: "" }]
      : [{ from: cutFrom, to: cutTo, insert: "" }, { from: insertAt, insert: insertText }]
  return { changes }
}

// #84: the keyboard-move commands (Alt-Shift-Up/Down) were removed per review (comment 696):
// vim users reorder with dd→move→p (atom dd/yy exist) and mouse users drag the gutter grip, so the
// middle-tier keyboard move had no demand and only added keybinding/maintenance surface. computeBlockMove
// stays — the drag path (block-drag.ts) is its only caller now.
