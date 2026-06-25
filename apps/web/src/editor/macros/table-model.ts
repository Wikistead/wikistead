// A logical table grid shared by the Tier-1 (GFM pipe) and Tier-2 (:::table HTML)
// forms, plus the merge/unmerge operations that move a table between tiers (ADR-022
// Part 10). A grid is a rectangular matrix: an origin cell, or null where a spanning
// cell to the up/left covers the position. Promotion/demotion is just "serialize the
// grid as HTML (if it has spans) or as pipes (if it doesn't)".

// Cell styling that GFM pipes can't express — its presence promotes a table to the
// :::table HTML tier. STRICT allowlist (ADR-022 review #2): only these four properties,
// only safe values. Anything else (arbitrary CSS, javascript:/url()/expression, other
// props) is dropped on parse — this is the XSS boundary for both rendered and
// vim-hand-edited :::table HTML.
export interface CellStyle {
  bg?: string; // background color
  color?: string; // text color
  width?: string; // column width
  height?: string; // row height
  align?: "left" | "center" | "right";
}
export interface TCell {
  text: string;
  header: boolean;
  colspan: number;
  rowspan: number;
  style?: CellStyle;
}
export type Grid = (TCell | null)[][]; // null = covered by a spanning origin

// Safe value patterns: a hex color or a theme-token var() (no url()/javascript:/expr);
// width is a bare number + px/%. align is an enum.
const COLOR_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$|^var\(--[a-z0-9-]+\)$/i;
const WIDTH_RE = /^\d{1,5}(?:px|%)$/;
const ALIGNS = new Set(["left", "center", "right"]);

// Parse a raw style="" string → an allowlisted CellStyle (drops everything not on the
// four-property allowlist or whose value isn't safe). The ONLY way style enters the grid.
export function sanitizeStyle(raw: string): CellStyle | undefined {
  const out: CellStyle = {};
  for (const decl of raw.split(";")) {
    const i = decl.indexOf(":");
    if (i < 0) continue;
    const prop = decl.slice(0, i).trim().toLowerCase();
    const val = decl.slice(i + 1).trim();
    if (!val) continue;
    if ((prop === "background" || prop === "background-color") && COLOR_RE.test(val)) out.bg = val;
    else if (prop === "color" && COLOR_RE.test(val)) out.color = val;
    else if (prop === "width" && WIDTH_RE.test(val)) out.width = val;
    else if (prop === "height" && WIDTH_RE.test(val)) out.height = val;
    else if (prop === "text-align" && ALIGNS.has(val.toLowerCase())) out.align = val.toLowerCase() as CellStyle["align"];
  }
  return Object.keys(out).length ? out : undefined;
}

export function styleToCss(s: CellStyle): string {
  const p: string[] = [];
  if (s.bg) p.push(`background:${s.bg}`);
  if (s.color) p.push(`color:${s.color}`);
  if (s.width) p.push(`width:${s.width}`);
  if (s.height) p.push(`height:${s.height}`);
  if (s.align) p.push(`text-align:${s.align}`);
  return p.join(";");
}

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

// Parse a table block's SOURCE TEXT → grid, detecting the tier: a `:::table` directive
// (HTML body between the ::: fences) or a GFM pipe table. Used by the view-free inline
// editor, which only gets the source via InnerEditHost.getSource() (ADR-025 step 2).
export function parseTableSource(src: string): Grid {
  const lines = src.split("\n");
  if (lines[0]?.trimStart().startsWith(":::")) {
    let end = lines.length;
    if (lines[end - 1]?.trim() === ":::") end -= 1;
    return parseHtml(lines.slice(1, end).join("\n"));
  }
  return parsePipe(src);
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
      const style = sanitizeStyle(/style\s*=\s*"([^"]*)"/i.exec(attrs)?.[1] ?? ""); // allowlist
      grid[r]![c] = { text: unesc(m[3]!).trim(), header: m[1]!.toLowerCase() === "th", colspan, rowspan, ...(style ? { style } : {}) };
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

const hasStyle = (grid: Grid): boolean => grid.some((row) => row.some((c) => c && c.style));
// GFM pipes express a header ONLY as row 0 — they cannot put a <th> in a body row. So a
// header BELOW row 0 is the pipe-inexpressible case → HTML tier. (Row 0 being td-only is
// fine: toPipe renders row 0 as the header.)
const complexHeader = (grid: Grid): boolean => grid.some((row, r) => r > 0 && row.some((c) => c && c.header));

export function toHtml(grid: Grid): string {
  let s = "<table>";
  for (const row of grid) {
    s += "<tr>";
    for (const cell of row) {
      if (!cell) continue;
      const tag = cell.header ? "th" : "td";
      const cs = cell.colspan > 1 ? ` colspan="${cell.colspan}"` : "";
      const rs = cell.rowspan > 1 ? ` rowspan="${cell.rowspan}"` : "";
      const st = cell.style ? ` style="${styleToCss(cell.style)}"` : "";
      s += `<${tag}${cs}${rs}${st}>${esc(cell.text)}</${tag}>`;
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

const cloneGrid = (grid: Grid): Grid => grid.map((row) => row.map((cell) => (cell ? { ...cell } : null)));
const ncolsOf = (grid: Grid): number => grid.reduce((m, r) => Math.max(m, r.length), 0);
// Fill any undefined holes left by span bookkeeping with empty 1×1 cells (keeps the grid
// rectangular so toPipe/toHtml are well-defined).
function normalizeGrid(grid: Grid): Grid {
  const n = ncolsOf(grid);
  for (const row of grid) for (let c = 0; c < n; c++) if (row[c] === undefined) row[c] = { text: "", header: false, colspan: 1, rowspan: 1 };
  return grid;
}

// Insert an empty column before index `at` (0..ncols). A cell whose horizontal span
// crosses the boundary is widened (the new slot becomes one of its covered positions);
// otherwise a fresh empty cell is inserted. Everything to the right shifts.
export function insertColAt(grid: Grid, at: number): Grid {
  const g = cloneGrid(grid);
  for (const row of g) {
    let inside = false;
    for (let c = at - 1; c >= 0; c--) {
      const cell = row[c];
      if (cell) { if (c + cell.colspan > at) { cell.colspan += 1; inside = true; } break; }
    }
    const nb = row[at] ?? row[at - 1] ?? row.find((c) => c);
    row.splice(at, 0, inside ? null : { text: "", header: !!nb?.header, colspan: 1, rowspan: 1 });
  }
  return normalizeGrid(g);
}

// Insert an empty row before index `at` (0..nrows). A cell whose vertical span crosses the
// boundary is heightened; otherwise a fresh empty cell is inserted. Rows below shift down.
export function insertRowAt(grid: Grid, at: number): Grid {
  const g = cloneGrid(grid);
  const n = ncolsOf(g);
  const newRow: (TCell | null)[] = [];
  for (let c = 0; c < n; c++) {
    let inside = false;
    for (let r = at - 1; r >= 0; r--) {
      const cell = g[r]?.[c];
      if (cell) { if (r + cell.rowspan > at) { cell.rowspan += 1; inside = true; } break; }
    }
    newRow.push(inside ? null : { text: "", header: false, colspan: 1, rowspan: 1 });
  }
  g.splice(at, 0, newRow);
  return normalizeGrid(g);
}

// Delete column `at`. A cell spanning across `at` shrinks by one; an origin that sits AT
// `at` and spans right hands its data to the next slot (so content is not lost).
export function deleteColAt(grid: Grid, at: number): Grid {
  if (ncolsOf(grid) <= 1) return cloneGrid(grid); // never delete the last column
  const g = cloneGrid(grid);
  for (const row of g) {
    const cell = row[at];
    if (cell && cell.colspan > 1) row[at + 1] = { ...cell, colspan: cell.colspan - 1 };
    else if (!cell) {
      for (let c = at - 1; c >= 0; c--) { const o = row[c]; if (o) { if (c + o.colspan > at) o.colspan -= 1; break; } }
    }
    row.splice(at, 1);
  }
  return normalizeGrid(g);
}

// Delete row `at`, symmetric to deleteColAt.
export function deleteRowAt(grid: Grid, at: number): Grid {
  if (grid.length <= 1) return cloneGrid(grid); // never delete the last row
  const g = cloneGrid(grid);
  const n = ncolsOf(g);
  for (let c = 0; c < n; c++) {
    const cell = g[at]?.[c];
    if (cell && cell.rowspan > 1) { if (g[at + 1]) g[at + 1]![c] = { ...cell, rowspan: cell.rowspan - 1 }; }
    else if (!cell) {
      for (let r = at - 1; r >= 0; r--) { const o = g[r]?.[c]; if (o) { if (r + o.rowspan > at) o.rowspan -= 1; break; } }
    }
  }
  g.splice(at, 1);
  return normalizeGrid(g);
}

// Serialize to the lowest tier that can represent the grid: pipes if span-free
// (Tier 1), else a :::table HTML directive (Tier 2). This IS the promote/demote rule.
export function serialize(grid: Grid): { tier: "pipe" | "html"; text: string } {
  const needsHtml = hasSpans(grid) || hasStyle(grid) || complexHeader(grid);
  return needsHtml ? { tier: "html", text: toHtml(grid) } : { tier: "pipe", text: toPipe(grid) };
}
