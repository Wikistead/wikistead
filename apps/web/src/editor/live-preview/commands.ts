import { EditorSelection, type ChangeSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";

// SyntaxNode derived from syntaxTree's return type — @lezer/common is a transitive dep we don't
// declare (pnpm strict node_modules), and @codemirror/language doesn't re-export the type.
type SyntaxNode = ReturnType<ReturnType<typeof syntaxTree>["resolveInner"]>;

// Toolbar commands for the non-technical surface. Each is a plain CodeMirror
// transaction on the live-preview view. Because the view is bound to the
// canonical Y.Text via yCollab, every insertion propagates to the vim surface
// and persists through the existing pipeline — no toolbar-specific Yjs wiring.

// #236: an inline format is a TOGGLE, not a blind wrap. Coverage is judged on the SYNTAX TREE
// (not string matching), and the edit stays a plain offset-invariant change set (single Y.Text).
// Word-processor semantics:
//   - selection fully inside one formatted node → REMOVE: unwrap the whole node when the selection
//     covers all of its content; SPLIT it when the selection is a sub-range (`**ab|cd|ef**` →
//     `**ab**cd**ef**` — only the selected part loses the mark);
//   - mixed / not covered → APPLY-UNIFY: absorb every same-type node intersecting the selection
//     (delete their delimiters, extend the wrap over them) and wrap ONCE — no nested/broken
//     `**a**b**` fragments (the ticket's mixed-selection edge case; a second press removes it all);
//   - empty selection → insert the pair with the caret between (unchanged pre-#236 behaviour).

// The opening/closing delimiter children of a formatted node ("EmphasisMark"/"CodeMark"/
// "StrikethroughMark"): the first Mark child starting at node.from and the last ending at node.to.
// Null when either is missing (malformed edge) → callers fall back to the apply path.
function delimiterMarks(node: SyntaxNode): { open: { from: number; to: number }; close: { from: number; to: number } } | null {
  let open: { from: number; to: number } | null = null;
  let close: { from: number; to: number } | null = null;
  for (let c = node.firstChild; c; c = c.nextSibling) {
    if (!c.name.endsWith("Mark")) continue;
    if (c.from === node.from) open = { from: c.from, to: c.to };
    if (c.to === node.to) close = { from: c.from, to: c.to };
  }
  return open && close && open.to <= close.from ? { open, close } : null;
}

// Toggle `marker` around each selection range against the syntax-tree nodes in `nodeNames`
// (e.g. "**" ↔ StrongEmphasis).
function wrap(view: EditorView, marker: string, nodeNames: readonly string[]): void {
  const { state } = view;
  const tree = syntaxTree(state);
  const tr = state.changeByRange((range) => {
    // Empty selection: insert the pair, caret between (e.g. "**|**") — unchanged.
    if (range.empty) {
      return {
        changes: [{ from: range.from, insert: marker + marker }],
        range: EditorSelection.cursor(range.from + marker.length),
      };
    }
    const changes: ChangeSpec[] = [];
    // Is the whole selection inside ONE formatted node of this type? (resolveInner + parent walk;
    // the node must span the selection's end too.)
    let covering: SyntaxNode | null = null;
    for (let n: SyntaxNode | null = tree.resolveInner(range.from, 1); n; n = n.parent) {
      if (nodeNames.includes(n.name) && n.to >= range.to) { covering = n; break; }
    }
    const marks = covering ? delimiterMarks(covering) : null;
    if (covering && marks) {
      const contentFrom = marks.open.to;
      const contentTo = marks.close.from;
      // "Covers the whole content" must ignore NESTED delimiter marks: in `***hello***` the outer
      // Emphasis' content is `**hello**`, so selecting just "hello" leaves only the inner Strong's
      // `**`s outside the selection — that still IS the whole italic TEXT. Collect every *Mark range
      // in the covering node's subtree and check the leftover content is marks-only.
      const markRanges: { from: number; to: number }[] = [];
      tree.iterate({
        from: covering.from,
        to: covering.to,
        enter: (n) => { if (n.name.endsWith("Mark")) markRanges.push({ from: n.from, to: n.to }); },
      });
      const marksOnly = (from: number, to: number): boolean => {
        let pos = from;
        while (pos < to) {
          const m = markRanges.find((r) => r.from <= pos && r.to > pos);
          if (!m) return false;
          pos = m.to;
        }
        return true;
      };
      const coversAllText = range.from <= contentFrom || marksOnly(contentFrom, range.from);
      const coversAllTextEnd = range.to >= contentTo || marksOnly(range.to, contentTo);
      if (coversAllText && coversAllTextEnd) {
        // Covers the whole content (or includes the delimiters) → unwrap the node.
        changes.push({ from: marks.open.from, to: marks.open.to }, { from: marks.close.from, to: marks.close.to });
      } else {
        // Sub-range inside the node → split: close before the selection, reopen after it. At a
        // content edge, move the delimiter instead (never leave an empty `` ** `` pair behind).
        if (range.from > contentFrom) changes.push({ from: range.from, insert: marker });
        else changes.push({ from: marks.open.from, to: marks.open.to });
        if (range.to < contentTo) changes.push({ from: range.to, insert: marker });
        else changes.push({ from: marks.close.from, to: marks.close.to });
      }
    } else {
      // Mixed or unformatted → apply-unify: absorb intersecting same-type nodes into one wrap.
      let wrapFrom = range.from;
      let wrapTo = range.to;
      tree.iterate({
        from: range.from,
        to: range.to,
        enter: (n) => {
          if (!nodeNames.includes(n.name)) return;
          const m = delimiterMarks(n.node);
          if (!m) return false;
          changes.push({ from: m.open.from, to: m.open.to }, { from: m.close.from, to: m.close.to });
          wrapFrom = Math.min(wrapFrom, n.from);
          wrapTo = Math.max(wrapTo, n.to);
          return false; // don't descend into an absorbed node (no double handling)
        },
      });
      changes.push({ from: wrapFrom, insert: marker }, { from: wrapTo, insert: marker });
    }
    // Map the selection through this range's changes so it keeps covering the same text.
    const cs = state.changes(changes);
    return {
      changes,
      range: EditorSelection.range(cs.mapPos(range.from, 1), cs.mapPos(range.to, -1)),
    };
  });
  view.dispatch(state.update(tr, { scrollIntoView: true }));
  view.focus();
}

// Prepend `prefix` to every line the selection touches.
function prefixLines(view: EditorView, prefix: string): void {
  const { state } = view;
  const seen = new Set<number>();
  const changes: { from: number; insert: string }[] = [];
  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from).number;
    const last = state.doc.lineAt(range.to).number;
    for (let n = first; n <= last; n++) {
      if (seen.has(n)) continue;
      seen.add(n);
      changes.push({ from: state.doc.line(n).from, insert: prefix });
    }
  }
  view.dispatch(state.update({ changes, scrollIntoView: true }));
  view.focus();
}

export const toggleBold = (view: EditorView) => wrap(view, "**", ["StrongEmphasis"]);
export const toggleItalic = (view: EditorView) => wrap(view, "*", ["Emphasis"]);
export const toggleStrikethrough = (view: EditorView) => wrap(view, "~~", ["Strikethrough"]);
export const toggleHighlight = (view: EditorView) => wrap(view, "==", ["Highlight"]); // #334 / ADR-129: `==text==` → <mark>
export const toggleInlineCode = (view: EditorView) => wrap(view, "`", ["InlineCode"]);
export const setHeading = (view: EditorView, level = 2) =>
  prefixLines(view, `${"#".repeat(level)} `);
export const toggleBulletList = (view: EditorView) => prefixLines(view, "- ");
// (Block inserts — code block / table / divider — and the heading/list/quote toggles
// for the slash palette are template-based in palette.ts, which controls the caret
// position precisely; they don't go through these line-prefix helpers.)

// The SINGLE source of the layer-A (inline) format set, shared by every decoration
// door so they can't drift (ADR-018 #3): the selection toolbar (mouse), the `\`
// selection palette (vim), and selection-`/` (keyboard). Each entry renders the same
// command differently (toolbar = symbol; palette = label + mnemonic) but runs the SAME
// function on the SAME selection — same target, many doors. `mnemonic` is the
// single-key fast-path inside the palette (ADR-018 #2).
export interface InlineFormat { id: string; symbol: string; labelKey: string; mnemonic: string; run: (v: EditorView) => void }
export const INLINE_FORMATS: InlineFormat[] = [
  { id: "bold", symbol: "B", labelKey: "lpToolbar.bold", mnemonic: "b", run: toggleBold },
  { id: "italic", symbol: "I", labelKey: "palette.italic", mnemonic: "i", run: toggleItalic },
  { id: "strike", symbol: "S", labelKey: "palette.strikethrough", mnemonic: "s", run: toggleStrikethrough },
  { id: "highlight", symbol: "H", labelKey: "palette.highlight", mnemonic: "h", run: toggleHighlight }, // #334 / ADR-129
  { id: "code", symbol: "</>", labelKey: "lpToolbar.inlineCode", mnemonic: "c", run: toggleInlineCode },
  { id: "link", symbol: "Link", labelKey: "lpToolbar.link", mnemonic: "l", run: insertLink },
];

// Uploads a chosen image file and returns the reference + alt to insert (or null
// to cancel/fail). Provided by the host (it knows the page + auth); omitted = no
// image entry (e.g. guests, or surfaces without an uploader). Lives here with
// insertImage so both the `/` insert palette and drag-drop import it from one place.
export type ImageUploader = (file: File) => Promise<{ ref: string; alt: string } | null>;

// Insert "[text](url)" and leave the caret selecting "url" so it can be typed
// Insert an image reference at the caret: ![alt](wks-attachment:<id>). The ref is
// the stable attachment id (resolved to a presigned URL at render time — never
// persisted). Propagates to the vim surface + Y.Text like any other edit.
export function insertImage(view: EditorView, alt: string, ref: string): void {
  view.dispatch(view.state.replaceSelection(`![${alt}](${ref})`));
  view.focus();
}

// #273 / ADR-120: insert a FILE attachment reference — [name](wks-attachment:<id>), the image
// form minus the `!`. A standard Markdown link (Open formats: no custom syntax, no degrade);
// the display layer renders the chip / download card / inline viewer from the stable id.
export function insertAttachment(view: EditorView, name: string, ref: string): void {
  view.dispatch(view.state.replaceSelection(`[${name}](${ref})`));
  view.focus();
}

// over. With a selection, the selected text becomes the link label.
export function insertLink(view: EditorView): void {
  const { state } = view;
  const tr = state.changeByRange((range) => {
    const before = "[";
    const mid = "](";
    const url = "url";
    const after = ")";
    const urlStart = range.to + before.length + mid.length;
    return {
      changes: [
        { from: range.from, insert: before },
        { from: range.to, insert: `${mid}${url}${after}` },
      ],
      range: EditorSelection.range(urlStart, urlStart + url.length),
    };
  });
  view.dispatch(state.update(tr, { scrollIntoView: true }));
  view.focus();
}
