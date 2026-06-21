import { EditorSelection } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

// Toolbar commands for the non-technical surface. Each is a plain CodeMirror
// transaction on the live-preview view. Because the view is bound to the
// canonical Y.Text via yCollab, every insertion propagates to the vim surface
// and persists through the existing pipeline — no toolbar-specific Yjs wiring.

// Wrap each selection range with `before`/`after`. Empty selection -> insert the
// pair and place the caret between them (e.g. "**|**").
function wrap(view: EditorView, before: string, after: string): void {
  const { state } = view;
  const tr = state.changeByRange((range) => ({
    changes: [
      { from: range.from, insert: before },
      { from: range.to, insert: after },
    ],
    range: EditorSelection.range(
      range.from + before.length,
      range.to + before.length,
    ),
  }));
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

export const toggleBold = (view: EditorView) => wrap(view, "**", "**");
export const toggleItalic = (view: EditorView) => wrap(view, "*", "*");
export const toggleInlineCode = (view: EditorView) => wrap(view, "`", "`");
export const setHeading = (view: EditorView, level = 2) =>
  prefixLines(view, `${"#".repeat(level)} `);
export const toggleBulletList = (view: EditorView) => prefixLines(view, "- ");

// Insert "[text](url)" and leave the caret selecting "url" so it can be typed
// Insert an image reference at the caret: ![alt](wks-attachment:<id>). The ref is
// the stable attachment id (resolved to a presigned URL at render time — never
// persisted). Propagates to the vim surface + Y.Text like any other edit.
export function insertImage(view: EditorView, alt: string, ref: string): void {
  view.dispatch(view.state.replaceSelection(`![${alt}](${ref})`));
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
