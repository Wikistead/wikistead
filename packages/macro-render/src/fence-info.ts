// #198 / ADR-094: parse a code-fence info string into lang + an ATTRIBUTE list — the extensible
// container the ticket asks for (add an attribute = one entry here, never a re-parse). Grammar:
//
//   ```<lang> [attr ...]
//
// where each attr is `key="value"` / `key='value'` (quoted string), `key` (bare boolean flag), or
// `{<ranges>}` (comma-separated single lines or a-b ranges, the de-facto highlight notation). Unknown
// attributes are PRESERVED verbatim on `extra` and re-serialized, so a fence written for a future/other
// attribute is never dropped on round-trip. Pure + DOM-free → shared by the editor and the server HTML
// export (single source of truth, ADR-085).

export type FenceAlign = "left" | "center" | "right";

export interface FenceInfo {
  lang: string;
  title?: string;
  showLineNumbers?: boolean;
  highlight?: ReadonlyArray<readonly [number, number]>; // inclusive 1-based line ranges (single line = [n,n])
  // #255: horizontal alignment for a rendered diagram fence (mermaid/plantuml/excalidraw). CENTER is the
  // default and writes NO attribute (existing docs stay unchanged and centre) — only left/right serialize.
  align?: FenceAlign;
  extra: string[]; // unknown attributes, kept verbatim for a lossless round-trip
}

// Tokenize an info string into whitespace-separated attributes, respecting "…"/'…' quotes and {…}.
function tokenize(s: string): string[] {
  const out: string[] = [];
  let i = 0;
  const ws = (c: string) => c === " " || c === "\t";
  while (i < s.length) {
    while (i < s.length && ws(s[i]!)) i++;
    if (i >= s.length) break;
    let tok = "";
    if (s[i] === "{") {
      while (i < s.length && s[i] !== "}") { tok += s[i]!; i++; }
      if (i < s.length) { tok += s[i]!; i++; } // closing }
    } else {
      while (i < s.length && !ws(s[i]!)) {
        const c = s[i]!;
        if (c === '"' || c === "'") {
          tok += c; i++;
          while (i < s.length && s[i] !== c) { tok += s[i]!; i++; }
          if (i < s.length) { tok += s[i]!; i++; } // closing quote
        } else { tok += c; i++; }
      }
    }
    out.push(tok);
  }
  return out;
}

// Parse "{1,3-5}" → [[1,1],[3,5]]. Invalid/empty parts are skipped; returns undefined when nothing valid.
function parseRanges(tok: string): ReadonlyArray<readonly [number, number]> | undefined {
  const inner = tok.replace(/^\{|\}$/g, "");
  const ranges: [number, number][] = [];
  for (const part of inner.split(",")) {
    const p = part.trim();
    if (!p) continue;
    const m = /^(\d+)(?:-(\d+))?$/.exec(p);
    if (!m) continue;
    const a = Number(m[1]), b = m[2] ? Number(m[2]) : a;
    ranges.push(a <= b ? [a, b] : [b, a]);
  }
  return ranges.length ? ranges : undefined;
}

// The fence markers + the info string: ```ts title="app.ts" → info "ts title=…". null = not a fence.
const FENCE_RE = /^\s*(?:`{3,}|~{3,})\s*(.*)$/;

// Parse the info string AFTER the fence markers (e.g. `ts title="app.ts" showLineNumbers {1,3-5}`).
export function parseFenceInfo(info: string): FenceInfo {
  const toks = tokenize(info.trim());
  const out: FenceInfo = { lang: toks[0] ?? "", extra: [] };
  for (let k = 1; k < toks.length; k++) {
    const t = toks[k]!;
    if (t.startsWith("{")) {
      const r = parseRanges(t);
      if (r) out.highlight = r;
      else out.extra.push(t);
      continue;
    }
    const eq = t.indexOf("=");
    if (eq === -1) {
      if (t === "showLineNumbers") out.showLineNumbers = true;
      else out.extra.push(t);
      continue;
    }
    const key = t.slice(0, eq);
    const raw = t.slice(eq + 1);
    const val = raw.length >= 2 && (raw[0] === '"' || raw[0] === "'") && raw[raw.length - 1] === raw[0] ? raw.slice(1, -1) : raw;
    if (key === "title") out.title = val;
    else if (key === "align" && (val === "left" || val === "center" || val === "right")) out.align = val;
    else out.extra.push(t);
  }
  return out;
}

// Parse the FULL opening fence line (with ``` / ~~~ markers). null when the line is not a fence.
export function parseFenceLine(firstLine: string): FenceInfo | null {
  const m = FENCE_RE.exec(firstLine);
  return m ? parseFenceInfo(m[1]!) : null;
}

const serializeRanges = (r: ReadonlyArray<readonly [number, number]>) =>
  "{" + r.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(",") + "}";

// Rebuild the info string from a descriptor. parse∘serialize is stable (round-trip safe), and unknown
// attributes on `extra` are re-emitted so nothing is lost.
export function serializeFenceInfo(info: FenceInfo): string {
  const parts = [info.lang];
  if (info.title !== undefined) parts.push(`title="${info.title}"`);
  if (info.showLineNumbers) parts.push("showLineNumbers");
  if (info.highlight && info.highlight.length) parts.push(serializeRanges(info.highlight));
  if (info.align && info.align !== "center") parts.push(`align=${info.align}`); // #255: center = default (no attr)
  parts.push(...info.extra);
  return parts.filter((p) => p !== "").join(" ");
}
