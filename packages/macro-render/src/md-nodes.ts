// #384: shared markdown-node helpers used by BOTH renderers — the editor's DOM walker (apps/web md-render.ts)
// and this package's SafeHtml walker (render.ts). Small, pure, byte-identical tables/extractors that were
// hand-mirrored; keeping them here means a Markdown-grammar change (a new heading node, the footnote ref shape)
// lands once. The node-by-node ELEMENT construction still lives in each sink (DOM vs SafeHtml are asymmetric —
// interactive widgets vs static export), but these judgments are the same on both sides.

// Lezer heading node name → HTML tag. A FIXED allowlist (never user input) — the render sinks wrap with it, so
// it is safe to emit as a tag literal. ATX (`# …`) 1–6 and Setext (`===`/`---`) map to h1–h6.
export const HEADINGS: Record<string, string> = {
  ATXHeading1: "h1", ATXHeading2: "h2", ATXHeading3: "h3", ATXHeading4: "h4", ATXHeading5: "h5", ATXHeading6: "h6",
  SetextHeading1: "h1", SetextHeading2: "h2",
};

// The label inside a footnote reference node `[^label]`: strip the leading `[^` (2 chars) and the trailing `]`.
export const footnoteRefLabel = (src: string, from: number, to: number): string => src.slice(from + 2, to - 1);
