import { syntaxTree, ensureSyntaxTree } from "@codemirror/language";
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

// #345 how much parse work extractHeadings may force per call. Lezer parses LAZILY, and on a
// fresh load `syntaxTree(state)` covers only the initially displayed range — a long published page's
// TOC came out truncated (18 of 30 headings), so scrolling past the last known heading blanked the
// two-layer highlight entirely (active AND visible empty). 50ms parses typical wiki pages whole; when
// it is not enough, headingsExtension below re-extracts until the result stabilises.
const PARSE_BUDGET_MS = 50;

// Walk the syntax tree for ATXHeading{1..6}, returning ordered, slugged headings. The heading TEXT is
// the line minus the leading `#`s (HeaderMark) and one following space.
export function extractHeadings(state: EditorState): Heading[] {
  const out: Heading[] = [];
  const seen = new Set<string>();
  // #345 (fix 1): force the parse over the WHOLE document first. ensureSyntaxTree returns null
  // when the budget runs out — fall back to the partial tree (the extension retries until stable), so a
  // pathological document degrades to the old partial behaviour instead of blocking the UI thread.
  const tree = ensureSyntaxTree(state, state.doc.length, PARSE_BUDGET_MS) ?? syntaxTree(state);
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
//
// #345 (fix 2): the initial extraction can still be PARTIAL when the whole-document parse exceeds
// its budget — and the background parser then extends the tree WITHOUT a doc change, so a truncated TOC
// used to stay truncated forever. After each (re)extraction, keep re-extracting on a short timer until
// two consecutive runs agree (bounded attempts; every run may force up to PARSE_BUDGET_MS more parsing).
export function headingsExtension(onHeadings: (headings: Heading[]) => void): Extension {
  let inited = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  return EditorView.updateListener.of((u) => {
    if (!inited || u.docChanged) { // first update (initial content) + every doc edit; not on scroll
      inited = true;
      if (retryTimer != null) { clearTimeout(retryTimer); retryTimer = null; }
      let last = extractHeadings(u.state);
      onHeadings(last);
      let attempts = 0;
      let stableRuns = 0;
      const settle = () => {
        retryTimer = null;
        if (!u.view.dom.isConnected) return; // the editor unmounted — nothing to report to
        const next = extractHeadings(u.view.state);
        const changed = next.length !== last.length || next.some((h, i) => h.from !== last[i]!.from || h.text !== last[i]!.text);
        if (changed) {
          last = next;
          onHeadings(next);
          stableRuns = 0;
        } else {
          stableRuns++;
        }
        if (stableRuns < 2 && ++attempts < 8) retryTimer = setTimeout(settle, 120);
      };
      retryTimer = setTimeout(settle, 120);
    }
  });
}
