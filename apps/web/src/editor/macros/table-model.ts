// A logical table grid shared by the Tier-1 (GFM pipe) and Tier-2 (:::table HTML)
// forms, plus the merge/unmerge operations that move a table between tiers (ADR-022
// Part 10). A grid is a rectangular matrix: an origin cell, or null where a spanning
// cell to the up/left covers the position. Promotion/demotion is just "serialize the
// grid as HTML (if it has spans) or as pipes (if it doesn't)".

export interface TCell {
  text: string;
  header: boolean;
  colspan: number;
  rowspan: number;
}
export type Grid = (TCell | null)[][]; // null = covered by a spanning origin

const clampSpan = (v: string | null): number => {
  const n = v && /^\d+$/.test(v) ? Number(v) : 1;
  return n >= 1 && n <= 1000 ? n : 1;
};
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const unesc = (s: string) => s.replace(/<[^>]*>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

function splitPipeRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}
const isDelim = (cells: string[]) => cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c));

// Parse a GFM pipe table → a grid (all cells span 1). Row 0 is the header.
export function parsePipe(src: string): Grid {
  const lines = src.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("|"));
  const rows: string[][] = [];
  let hasHeader = false;
  for (let i = 0; i < lines.length; i++) {
    const cells = splitPipeRow(lines[i]!);
    if (i === 1 && isDelim(cells)) { hasHeader = true; continue; }
    rows.push(cells);
  }
  const ncols = rows.reduce((m, r) => Math.max(m, r.length), 0);
  return rows.map((r, ri) => {
    const out: (TCell | null)[] = [];
    for (let c = 0; c < ncols; c++) out.push({ text: r[c] ?? "", header: hasHeader && ri === 0, colspan: 1, rowspan: 1 });
    return out;
  });
}

// Parse an HTML <table> → a grid (honouring colspan/rowspan). String-based (no DOM) so
// it runs in node tests too; it parses OUR serialized HTML (and hand-edited variants).
// XSS is not a concern here — text is later set via textContent, never innerHTML.
export function parseHtml(html: string): Grid {
  const grid: Grid = [];
  const inner = /<table[^>]*>([\s\S]*?)<\/table>/i.exec(html)?.[1] ?? html;
  const trs = inner.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) ?? [];
  for (let r = 0; r < trs.length; r++) {
    grid[r] = grid[r] ?? [];
    let c = 0;
    const cellRe = /<(t[hd])\b([^>]*)>([\s\S]*?)<\/\1>/gi;
    let m: RegExpExecArray | null;
    while ((m = cellRe.exec(trs[r]!))) {
      while (grid[r]![c] !== undefined) c++; // skip cells covered by an earlier rowspan
      const attrs = m[2]!;
      const colspan = clampSpan(/colspan\s*=\s*"?(\d+)"?/i.exec(attrs)?.[1] ?? null);
      const rowspan = clampSpan(/rowspan\s*=\s*"?(\d+)"?/i.exec(attrs)?.[1] ?? null);
      grid[r]![c] = { text: unesc(m[3]!).trim(), header: m[1]!.toLowerCase() === "th", colspan, rowspan };
      for (let dr = 0; dr < rowspan; dr++) {
        for (let dc = 0; dc < colspan; dc++) {
          if (dr === 0 && dc === 0) continue;
          grid[r + dr] = grid[r + dr] ?? [];
          grid[r + dr]![c + dc] = null;
        }
      }
      c += colspan;
    }
  }
  // Normalize ragged rows: fill any holes (undefined) with empty cells.
  const ncols = grid.reduce((m, row) => Math.max(m, row.length), 0);
  for (const row of grid) for (let c = 0; c < ncols; c++) if (row[c] === undefined) row[c] = { text: "", header: false, colspan: 1, rowspan: 1 };
  return grid;
}

export function hasSpans(grid: Grid): boolean {
  return grid.some((row) => row.some((cell) => cell && (cell.colspan > 1 || cell.rowspan > 1)));
}

export function toHtml(grid: Grid): string {
  let s = "<table>";
  for (const row of grid) {
    s += "<tr>";
    for (const cell of row) {
      if (!cell) continue;
      const tag = cell.header ? "th" : "td";
      const cs = cell.colspan > 1 ? ` colspan="${cell.colspan}"` : "";
      const rs = cell.rowspan > 1 ? ` rowspan="${cell.rowspan}"` : "";
      s += `<${tag}${cs}${rs}>${esc(cell.text)}</${tag}>`;
    }
    s += "</tr>";
  }
  return s + "</table>";
}

// Serialize a span-free grid as a GFM pipe table (row 0 is the header).
export function toPipe(grid: Grid): string {
  if (!grid.length) return "";
  const ncols = grid[0]!.length;
  const row = (cells: (TCell | null)[]) => "| " + cells.map((c) => (c ? c.text : "")).join(" | ") + " |";
  const out = [row(grid[0]!), "| " + Array(ncols).fill("---").join(" | ") + " |"];
  for (let r = 1; r < grid.length; r++) out.push(row(grid[r]!));
  return out.join("\n");
}

// Merge the rectangle [r1..r2] × [c1..c2] into its top-left origin (concatenating the
// non-empty texts); the other positions become covered (null).
export function mergeRect(grid: Grid, r1: number, c1: number, r2: number, c2: number): Grid {
  const g = grid.map((row) => row.map((cell) => (cell ? { ...cell } : null)));
  const origin = g[r1]?.[c1];
  if (!origin) return g;
  const texts: string[] = [];
  for (let r = r1; r <= r2; r++) {
    for (let c = c1; c <= c2; c++) {
      const cell = g[r]?.[c];
      if (cell && cell.text) texts.push(cell.text);
      if (!(r === r1 && c === c1)) g[r]![c] = null;
    }
  }
  origin.text = texts.join(" ");
  origin.colspan = c2 - c1 + 1;
  origin.rowspan = r2 - r1 + 1;
  return g;
}

// Split a merged origin back into 1×1 cells (covered positions become empty cells).
export function unmergeAt(grid: Grid, r: number, c: number): Grid {
  const g = grid.map((row) => row.map((cell) => (cell ? { ...cell } : null)));
  const origin = g[r]?.[c];
  if (!origin) return g;
  const { colspan, rowspan, header } = origin;
  for (let dr = 0; dr < rowspan; dr++) {
    for (let dc = 0; dc < colspan; dc++) {
      if (dr === 0 && dc === 0) continue;
      g[r + dr]![c + dc] = { text: "", header, colspan: 1, rowspan: 1 };
    }
  }
  origin.colspan = 1;
  origin.rowspan = 1;
  return g;
}

// Serialize to the lowest tier that can represent the grid: pipes if span-free
// (Tier 1), else a :::table HTML directive (Tier 2). This IS the promote/demote rule.
export function serialize(grid: Grid): { tier: "pipe" | "html"; text: string } {
  return hasSpans(grid) ? { tier: "html", text: toHtml(grid) } : { tier: "pipe", text: toPipe(grid) };
}
