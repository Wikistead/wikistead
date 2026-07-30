// #558: pasting a COMPLETE block chunk (the whole-block source #549's atomClipboard puts on the
// clipboard) at a caret that sits mid-line — which is exactly where ArrowLeft/ArrowRight out of an atom
// selection parks it (measured: ArrowRight lands INSIDE the "```mermaid" marker line) — spliced the
// chunk into the line and broke the notation (measured: "`````mermaid", the marker line split in two).
// The receiver normalizes instead: a block chunk always lands on its own line boundary, and never
// inside the block the caret is riding on. Ordinary text pastes are untouched — the trigger is the
// clipboard being one complete fence/directive block, nothing else.

// The clipboard text is one COMPLETE block chunk: its first line opens a fence (```/~~~) or a
// directive (:::name), and its last line is the matching close marker. This is the exact shape
// atomClipboard writes (whole lines, one block). Returns the chunk with trailing newlines stripped,
// or null for everything else (single lines, prose, fragments — the default paste handles those).
export function completeBlockChunk(raw: string): string | null {
  const text = (raw ?? "").replace(/[\r\n]+$/, "");
  if (!text.includes("\n")) return null;
  const lines = text.split("\n");
  const first = lines[0]!;
  const last = lines[lines.length - 1]!.trim();
  const fence = /^(`{3,}|~{3,})/.exec(first);
  if (fence) {
    const ch = fence[1]![0]!;
    // the close is a bare run of the SAME fence char, at least as long as the opener
    return new RegExp(`^\\${ch}{${fence[1]!.length},}$`).test(last) ? text : null;
  }
  const dir = /^(:{3,})\S/.exec(first);
  if (dir) {
    return new RegExp(`^:{${dir[1]!.length},}$`).test(last) ? text : null;
  }
  return null;
}

// Where the chunk goes. Pure over primitive facts so it unit-tests without an EditorState:
//   pos           — the caret (an EMPTY selection; a range paste keeps the default replace)
//   line          — the caret's line
//   block         — the whole-line range of the block macro the caret sits ON (atom edge / marker /
//                   revealed source), or null when the caret is in ordinary text
// Returns one insert-only change plus the post-insert caret. The caret steps PAST the pasted block
// (the next line, when one exists — the caller clamps to the new doc length): left inside it, the
// caret-in reveal showed the fresh paste as raw source, which reads as "it didn't render".
export function blockPasteInsert(
  chunk: string,
  pos: number,
  line: { from: number; to: number },
  block: { fromLineFrom: number; toLineTo: number } | null,
): { at: number; insert: string; cursor: number } {
  if (block) {
    // never split the block under the caret — the paste lands BESIDE it, whole. At the very start the
    // caret means "before this block"; anywhere else it means "after it" (ArrowRight's meaning).
    // before: the caret retreats to the previous line's end — the next line down is the ORIGINAL block,
    // and parking on it would reveal IT raw (the same misread the after-case cursor avoids).
    if (pos <= block.fromLineFrom) return { at: block.fromLineFrom, insert: chunk + "\n", cursor: Math.max(block.fromLineFrom - 1, 0) };
    return { at: block.toLineTo, insert: "\n" + chunk, cursor: block.toLineTo + chunk.length + 2 };
  }
  if (line.from === line.to) return { at: pos, insert: chunk, cursor: pos + chunk.length + 1 }; // an empty line IS a boundary
  if (pos === line.from) return { at: pos, insert: chunk + "\n", cursor: pos + chunk.length + 1 }; // line start: block above, line moves down
  return { at: line.to, insert: "\n" + chunk, cursor: line.to + chunk.length + 2 }; // mid/end of a text line: block below, line stays whole
}
