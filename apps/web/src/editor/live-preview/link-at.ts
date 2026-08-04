// #611 / ADR-211 §1: THE structural link judge. One module, syntax-tree only, four consumers — the
// insert/edit door (commands.ts), unlink, the nesting guard, the right-click menu (context-menu.ts)
// and the paste path (paste-linkify.ts). Two local judges predated this file and were re-pointed here
// in the same change; a fifth copy is the drift this consolidation exists to prevent.
import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";

export interface LinkHit {
  /** the whole `[label](url)` node */
  from: number;
  to: number;
  /** the label text range (between the brackets) */
  labelFrom: number;
  labelTo: number;
  /** the URL child range; equal to the node range when the Link has no URL child (reference links) */
  urlFrom: number;
  urlTo: number;
  /** true when a URL child exists (inline links, wks-attachment refs); false for `[a][ref]` */
  hasUrl: boolean;
}

/**
 * Every markdown Link node that [from,to] TOUCHES, in document order.
 *
 * Measured constraints (ADR-211 rev1, each was a review finding):
 * - `tree.iterate` over the range, never an ancestor walk: with `aa [foo](u) bb` fully selected both
 *   endpoints resolve OUTSIDE the Link and a walk finds nothing — and "select a paragraph containing
 *   a link, press Link" is the main nesting path.
 * - Boundary convention: a cursor TOUCHING a link's edge counts as inside it (the iterate range is
 *   probed one character wide when collapsed), so the edge cases cannot drift per consumer.
 * - Only `Link` nodes answer. Autolinks, bare URL nodes and Images are structurally different things
 *   and the scope table (ADR §5) keeps them out on purpose.
 */
export function linksTouching(state: EditorState, from: number, to: number): LinkHit[] {
  const tree = syntaxTree(state);
  // a collapsed cursor probes one character to each side, so "touching an edge" answers inside
  const probeFrom = from === to ? Math.max(0, from - 1) : from;
  const probeTo = from === to ? Math.min(state.doc.length, to + 1) : to;
  const hits: LinkHit[] = [];
  tree.iterate({
    from: probeFrom,
    to: probeTo,
    enter: (n) => {
      if (n.name !== "Link") return;
      let urlFrom = n.from, urlTo = n.to, hasUrl = false;
      let labelFrom = n.from, labelTo = n.to;
      const cur = n.node.cursor();
      if (cur.firstChild()) {
        // LinkMark children delimit the label: [ label ]( url )
        const marks: { from: number; to: number }[] = [];
        do {
          if (cur.name === "URL") { urlFrom = cur.from; urlTo = cur.to; hasUrl = true; }
          if (cur.name === "LinkMark") marks.push({ from: cur.from, to: cur.to });
        } while (cur.nextSibling());
        if (marks.length >= 2) { labelFrom = marks[0]!.to; labelTo = marks[1]!.from; }
      }
      hits.push({ from: n.from, to: n.to, labelFrom, labelTo, urlFrom, urlTo, hasUrl });
    },
  });
  hits.sort((a, b) => a.from - b.from);
  // iterate can enter the same node from nested traversal orders — dedupe by range
  return hits.filter((h, i) => i === 0 || h.from !== hits[i - 1]!.from || h.to !== hits[i - 1]!.to);
}

/** The FIRST link the range touches, or null — the overlap resolution ADR-211 §3 rules (option (b):
 *  the tree already knows the answer; a refusal dialog would make the user redo its work). */
export function linkAt(state: EditorState, from: number, to: number = from): LinkHit | null {
  return linksTouching(state, from, to)[0] ?? null;
}

/** The label text of a hit (what unlink leaves behind). */
export function linkLabel(state: EditorState, hit: LinkHit): string {
  return state.doc.sliceString(hit.labelFrom, hit.labelTo);
}

/** The URL text of a hit ("" for reference links). */
export function linkUrl(state: EditorState, hit: LinkHit): string {
  return hit.hasUrl ? state.doc.sliceString(hit.urlFrom, hit.urlTo) : "";
}
