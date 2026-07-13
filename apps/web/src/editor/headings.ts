import { syntaxTree } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import type { EditorState, Extension } from "@codemirror/state";
import { slugify } from "@wikistead/macro-render";

// #192 / ADR-091: table-of-contents heading model. Headings are DERIVED from the document's
// ATXHeading nodes (the same Lezer tree the live-preview uses) — never a second stored structure —
// so the TOC follows edits and is correct in every display mode (Source's raw `# x` is still a
// heading in the tree; a `#` inside a code fence is NOT an ATXHeading, so it is correctly ignored).

export interface Heading {
  level: number; // 1..6
  text: string; // heading text (the `#` markers + surrounding space stripped)
  from: number; // doc offset of the heading line start (scroll target)
  slug: string; // stable, unique id (GitHub-style, deduped)
}

// #325 / ADR-137: `slugify` now lives in @wikistead/macro-render (the DOM-free, shared anchor vocabulary
// the server section-transclusion + this editor extraction both run — structurally drift-proof). Re-exported
// here so the existing editor importers (and headings.test.ts) are unchanged.
export { slugify };

// Walk the syntax tree for ATXHeading{1..6}, returning ordered, slugged headings. The heading TEXT is
// the line minus the leading `#`s (HeaderMark) and one following space.
export function extractHeadings(state: EditorState): Heading[] {
  const out: Heading[] = [];
  const seen = new Set<string>();
  const tree = syntaxTree(state);
  tree.iterate({
    enter: (node) => {
      const m = /^ATXHeading([1-6])$/.exec(node.name);
      if (!m) return;
      const level = Number(m[1]);
      const raw = state.doc.sliceString(node.from, node.to);
      const text = raw.replace(/^\s*#{1,6}\s*/, "").replace(/\s+#*\s*$/, "").trim();
      out.push({ level, text, from: state.doc.lineAt(node.from).from, slug: slugify(text || `heading-${out.length + 1}`, seen) });
    },
  });
  return out;
}

// A CM extension that recomputes headings whenever the doc changes (and once at init) and hands them to
// the host via `onHeadings` (display-only — reads state, never dispatches). The host renders the TOC.
export function headingsExtension(onHeadings: (headings: Heading[]) => void): Extension {
  let inited = false;
  return EditorView.updateListener.of((u) => {
    if (!inited || u.docChanged) { // first update (initial content) + every doc edit; not on scroll
      inited = true;
      onHeadings(extractHeadings(u.state));
    }
  });
}
