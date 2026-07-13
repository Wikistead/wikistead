import { mdParser } from "./render.js";

// #325 / ADR-137: the SHARED heading vocabulary + section extractor. This is the single source of truth
// for (a) anchor slugs (TOC, #313 heading deep-links, the public reader) and (b) section boundaries
// (`:::embed-page` `#slug` transclusion). Both the editor (apps/web/headings.ts, which needs live doc
// offsets) and the server (transclude-resolve.ts) run THIS code on the SAME `mdParser` Lezer parse, so
// client and server are structurally incapable of disagreeing on what a heading/section is — a parity
// test pins it. DOM-free (strings only): no `document`, so it runs in the server too.

// GitHub-style slug: lowercase, spaces→'-', drop punctuation, collapse hyphens. Dedup with a `-2`, `-3`…
// suffix via the shared `seen` set (repeated headings get distinct anchors). Pure. Unicode letters/numbers
// are KEPT (\p{L}\p{N}, like github-slugger) so CJK headings get real anchors (#313). Moved here from
// apps/web/headings.ts (the web module now delegates to this — one implementation, one vocabulary).
export function slugify(text: string, seen: Set<string>): string {
  const base = text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "section";
  let slug = base;
  let n = 2;
  while (seen.has(slug)) slug = `${base}-${n++}`;
  seen.add(slug);
  return slug;
}

export interface MdHeading {
  level: number; // 1..6
  text: string; // heading text (the `#` markers + trailing `#`s stripped)
  slug: string; // stable, unique anchor (deduped)
  from: number; // string offset of the heading LINE start (section slice start)
  to: number; // string offset of the ATXHeading node end
}

// The heading TEXT is the node's text minus the leading `#`s and any trailing `#`s — byte-identical to
// the editor's extractHeadings() regex so the two agree on the same markdown (the parity contract).
function headingText(raw: string): string {
  return raw.replace(/^\s*#{1,6}\s*/, "").replace(/\s+#*\s*$/, "").trim();
}

// Walk the shared Lezer parse for ATXHeading{1..6}. A `#` inside a code fence is NOT an ATXHeading (the
// grammar never produces one there), so it is correctly ignored; a `# heading` inside a `:::` directive
// body IS an ATXHeading (the composite parses its content as Markdown), matching the editor TOC/anchors.
export function extractHeadingsFromMarkdown(md: string): MdHeading[] {
  const out: MdHeading[] = [];
  const seen = new Set<string>();
  const tree = mdParser.parse(md);
  tree.iterate({
    enter: (node) => {
      const m = /^ATXHeading([1-6])$/.exec(node.name);
      if (!m) return;
      const level = Number(m[1]);
      const text = headingText(md.slice(node.from, node.to));
      // Line start = the character after the previous newline (mirrors the editor's lineAt(node.from).from).
      const lineStart = md.lastIndexOf("\n", node.from - 1) + 1;
      out.push({ level, text, slug: slugify(text || `heading-${out.length + 1}`, seen), from: lineStart, to: node.to });
    },
  });
  return out;
}

// #325 / ADR-137 slice 1: extract ONE section by its anchor slug — the heading line through just before the
// next heading of the SAME OR HIGHER level (Obsidian section semantics; end of document otherwise). The
// returned slice INCLUDES the heading line (the fragment is self-titling). Returns null for an unknown slug
// so the caller renders the SAME existence-hiding placeholder as a denied page (no fragment-existence oracle).
export function sliceSectionBySlug(md: string, slug: string): string | null {
  const heads = extractHeadingsFromMarkdown(md);
  const idx = heads.findIndex((h) => h.slug === slug);
  if (idx === -1) return null;
  const level = heads[idx]!.level;
  let end = md.length;
  for (let j = idx + 1; j < heads.length; j++) {
    if (heads[j]!.level <= level) { end = heads[j]!.from; break; }
  }
  return md.slice(heads[idx]!.from, end).replace(/\s+$/, "");
}

// #325 / ADR-137 slice 2: extract ONE block by its explicit `^id` anchor (Obsidian block ref). The marker is a
// trailing ` ^<id>` on the block's last line (id: [a-z0-9-]{3,24}) — ordinary text in the single Y.Text. The
// enclosing "block" is the paragraph / list item / fenced code that carries it: on the shared Lezer parse, the
// innermost block node whose parent is the Document or a List (so a list item resolves to the ITEM, keeping its
// `-`, not the inner paragraph; a standalone paragraph / fenced code resolves to itself). The returned slice has
// the ` ^id` marker stripped (the transcluded fragment shows clean content). Duplicate ids resolve to the FIRST
// match (documented). Returns null for an unknown/invalid id — the SAME existence-hiding placeholder as a denied
// page (no fragment-existence oracle), never a parse error.
const BLOCK_REF_PARENTS = new Set(["Document", "BulletList", "OrderedList"]);
const BLOCK_REF_NODES = new Set(["Paragraph", "ListItem", "FencedCode", "CodeBlock", "Blockquote", "Table", "HTMLBlock"]);
export function sliceBlockByAnchor(md: string, id: string): string | null {
  if (!/^[a-z0-9-]{3,24}$/.test(id)) return null; // invalid id shape → same as unknown
  const esc = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const markerRe = new RegExp(`[ \\t]\\^${esc}(?![\\w-])`);
  const m = markerRe.exec(md);
  if (!m) return null;
  const markerPos = m.index; // the whitespace just before `^`
  const tree = mdParser.parse(md);
  let best: { from: number; to: number } | null = null;
  tree.iterate({
    enter: (node) => {
      if (!BLOCK_REF_NODES.has(node.name)) return;
      if (!BLOCK_REF_PARENTS.has(node.node.parent?.name ?? "")) return; // top-level block OR a list item only
      if (node.from <= markerPos && node.to >= markerPos) {
        if (!best || node.to - node.from < best.to - best.from) best = { from: node.from, to: node.to };
      }
    },
  });
  if (!best) return null;
  return md.slice((best as { from: number; to: number }).from, (best as { from: number; to: number }).to).replace(markerRe, "").replace(/\s+$/, "");
}
