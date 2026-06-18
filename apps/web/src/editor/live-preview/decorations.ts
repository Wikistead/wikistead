import { syntaxTree } from "@codemirror/language";
import type { EditorState, Range } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";

// Obsidian-style live preview: hide/style markdown syntax via CodeMirror
// decorations.
//
// INVARIANT (ADR-008 — the one non-obvious interaction in this surface):
// decorations are DISPLAY-ONLY and OFFSET-INVARIANT. `Decoration.replace` hides
// glyphs but never mutates the document; the CM doc stays 1:1 with the canonical
// Y.Text (kept in sync by yCollab). Remote collaborators' carets are drawn at
// Y.Text offsets (yCollab maps a Y RelativePosition -> absolute doc index ->
// doc.lineAt(index)), so any offset shift introduced here would misplace their
// cursors. Therefore this plugin ONLY ever returns a DecorationSet — it never
// dispatches a document change. reveal-on-cursor toggles WHICH markers are drawn,
// not the document length, so offsets are stable whether syntax is shown or not.

const strongMark = Decoration.mark({ class: "cm-lp-strong" });
const emphasisMark = Decoration.mark({ class: "cm-lp-emphasis" });
const inlineCodeMark = Decoration.mark({ class: "cm-lp-inline-code" });
const linkMark = Decoration.mark({ class: "cm-lp-link" });
const hide = Decoration.replace({});

const headingLine = (level: number) =>
  Decoration.line({ attributes: { class: `cm-lp-h cm-lp-h${level}` } });
const codeBlockLine = Decoration.line({ attributes: { class: "cm-lp-code-line" } });

class BulletWidget extends WidgetType {
  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-lp-bullet";
    span.textContent = "•";
    return span;
  }
  eq() {
    return true;
  }
}
const bullet = Decoration.replace({ widget: new BulletWidget() });

// A construct's syntax markers reveal (become editable raw text) when the main
// selection touches the LINE the marker sits on — matching Obsidian's per-line
// reveal. This only changes rendering, never offsets.
function lineRevealed(state: EditorState, pos: number): boolean {
  const line = state.doc.lineAt(pos);
  return state.selection.ranges.some((r) => r.from <= line.to && r.to >= line.from);
}

function buildDecorations(state: EditorState): {
  decorations: DecorationSet;
  atomic: DecorationSet;
} {
  const all: Range<Decoration>[] = [];
  const hidden: Range<Decoration>[] = [];
  const tree = syntaxTree(state);

  // Hide a marker range (and feed it to atomicRanges so local cursor motion skips
  // it cleanly) unless the cursor is on that line.
  const hideMarker = (from: number, to: number, deco: Decoration = hide) => {
    if (from >= to) return;
    if (lineRevealed(state, from)) return;
    all.push(deco.range(from, to));
    hidden.push(hide.range(from, to));
  };

  tree.iterate({
    enter: (node) => {
      const name = node.name;

      const heading = /^ATXHeading([1-6])$/.exec(name);
      if (heading) {
        const line = state.doc.lineAt(node.from);
        all.push(headingLine(Number(heading[1])).range(line.from));
        return; // descend to hide the HeaderMark child
      }

      if (name === "HeaderMark") {
        // Include the single trailing space so the heading text isn't indented.
        let to = node.to;
        if (state.doc.sliceString(to, to + 1) === " ") to += 1;
        hideMarker(node.from, to);
        return;
      }

      if (name === "StrongEmphasis") {
        all.push(strongMark.range(node.from, node.to));
        return;
      }
      if (name === "Emphasis") {
        all.push(emphasisMark.range(node.from, node.to));
        return;
      }
      if (name === "EmphasisMark") {
        hideMarker(node.from, node.to);
        return;
      }

      if (name === "InlineCode") {
        all.push(inlineCodeMark.range(node.from, node.to));
        return;
      }

      if (name === "FencedCode") {
        const first = state.doc.lineAt(node.from).number;
        const last = state.doc.lineAt(node.to).number;
        for (let n = first; n <= last; n++) {
          all.push(codeBlockLine.range(state.doc.line(n).from));
        }
        return; // descend to hide the fence CodeMark children
      }
      if (name === "CodeMark") {
        hideMarker(node.from, node.to);
        return;
      }

      if (name === "ListMark") {
        const list = node.node.parent?.parent?.name; // ListItem -> Bullet/OrderedList
        if (list === "BulletList") {
          // Replace "-"/"*" with a bullet glyph; the following space stays.
          hideMarker(node.from, node.to, bullet);
        }
        // OrderedList: keep the "1." number visible.
        return;
      }

      if (name === "Link") {
        all.push(linkMark.range(node.from, node.to));
        return; // descend to hide brackets + URL
      }
      if (name === "LinkMark" || name === "URL") {
        hideMarker(node.from, node.to);
        return;
      }
    },
  });

  return {
    decorations: Decoration.set(all, true),
    atomic: Decoration.set(hidden, true),
  };
}

// Rebuilds on docChanged (covers BOTH local edits AND remote Yjs updates applied
// by yCollab), viewport changes, and selection changes (reveal-on-cursor).
export const livePreview = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    atomic: DecorationSet;

    constructor(view: EditorView) {
      const built = buildDecorations(view.state);
      this.decorations = built.decorations;
      this.atomic = built.atomic;
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged || update.selectionSet) {
        const built = buildDecorations(update.state);
        this.decorations = built.decorations;
        this.atomic = built.atomic;
      }
    }
  },
  {
    decorations: (plugin) => plugin.decorations,
    provide: (plugin) =>
      EditorView.atomicRanges.of((view) => view.plugin(plugin)?.atomic ?? Decoration.none),
  },
);

export const livePreviewTheme = EditorView.baseTheme({
  ".cm-lp-strong": { fontWeight: "700" },
  ".cm-lp-emphasis": { fontStyle: "italic" },
  ".cm-lp-inline-code": {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    background: "rgba(127,127,127,0.18)",
    borderRadius: "3px",
    padding: "0 3px",
  },
  ".cm-lp-link": { color: "#4ea1ff", textDecoration: "underline" },
  ".cm-lp-h": { fontWeight: "700", lineHeight: "1.3" },
  ".cm-lp-h1": { fontSize: "1.8em" },
  ".cm-lp-h2": { fontSize: "1.5em" },
  ".cm-lp-h3": { fontSize: "1.3em" },
  ".cm-lp-h4": { fontSize: "1.15em" },
  ".cm-lp-h5": { fontSize: "1.05em" },
  ".cm-lp-h6": { fontSize: "1em", opacity: "0.85" },
  ".cm-lp-code-line": {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    background: "rgba(127,127,127,0.12)",
  },
  ".cm-lp-bullet": { paddingRight: "0.25em" },
});
