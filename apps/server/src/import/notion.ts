// #712 / ADR-227 §5 — the Notion dialect.
//
// Notion's "Markdown & CSV" export is a folder of Markdown, so the shared builder walks it the same
// way it walks a vault. What differs is a single pervasive detail and one structural decision:
//
//   FILENAME IDS. Every entry ends in a 32-hex id — `Team handbook abc123….md`, and its child pages
//   live in `Team handbook abc123…/`. The suffix is noise in a TITLE and load-bearing for LINKS,
//   because Notion's own internal links point at exactly those filenames. So it is stripped from the
//   title and kept as `sourceRef`, which is what makes link rewriting possible at all.
//
//   DATABASES DEGRADE TO A PAGE PLUS A TABLE. A `<Db name> <id>.csv` sits beside a directory of the
//   same name holding one page per row. This product is knowledge-first by ruling (the project design notes's north
//   star 2), so a database does not become a first-class object here; it becomes one page whose body
//   is a GFM table, with the row pages as its children. That IS a loss, and it is reported per
//   database rather than presented as a faithful import.
import type { ImportDegradation } from './index.js'

const HEX_SUFFIX = /[ _-]([0-9a-f]{32})$/i

/** Split a Notion export name into its human part and its id. `sourceRef` is the WHOLE base name. */
export function splitNotionName(base: string): { title: string; hex: string | null } {
  const m = HEX_SUFFIX.exec(base)
  if (!m) return { title: base, hex: null }
  return { title: base.slice(0, m.index).trim(), hex: m[1]!.toLowerCase() }
}

/** True when a folder of files looks like a Notion export (any entry carrying the 32-hex suffix). */
export function looksLikeNotionExport(paths: readonly string[]): boolean {
  return paths.some((p) => {
    const base = p.replace(/\.(md|csv)$/i, '')
    const leaf = base.slice(base.lastIndexOf('/') + 1)
    return HEX_SUFFIX.test(leaf)
  })
}

// ── CSV → GFM table ──────────────────────────────────────────────────────────
// A hand-written reader rather than a dependency: Notion writes RFC-4180 (quotes doubled inside
// quoted fields, newlines allowed inside them), and this is ~30 lines. Adding a parser here would
// mean an ADR-011 license review for something the format does not need.
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  const src = text.replace(/\r\n?/g, '\n')
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++ } else quoted = false
      } else field += ch
      continue
    }
    if (ch === '"') { quoted = true; continue }
    if (ch === ',') { row.push(field); field = ''; continue }
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue }
    field += ch
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row) }
  return rows.filter((r) => r.some((c) => c.trim() !== ''))
}

/** Render parsed CSV as a GFM table. Cell pipes are escaped so one value cannot split a row. */
export function csvToMarkdownTable(rows: readonly string[][]): string {
  if (rows.length === 0) return ''
  const esc = (c: string) => c.replace(/\|/g, '\\|').replace(/\n+/g, ' ').trim()
  const header = rows[0]!.map(esc)
  const out = [`| ${header.join(' | ')} |`, `|${header.map(() => '---').join('|')}|`]
  for (const r of rows.slice(1)) {
    const cells = header.map((_, i) => esc(r[i] ?? ''))
    out.push(`| ${cells.join(' | ')} |`)
  }
  return out.join('\n')
}

/**
 * The degradation a database import always carries. Named per database, with the row count, so the
 * report says what shrank rather than only that something did.
 */
export function databaseDegradation(name: string, rowCount: number): ImportDegradation {
  return {
    node: name,
    what: 'database became a page with a table',
    detail: `${rowCount} row(s) — Notion views (board, gallery, calendar), filters and sorts have no equivalent here`,
  }
}

/**
 * Rewrite Notion's internal links against a map keyed by the 32-hex id.
 *
 * Two shapes carry that id and both appear in real exports: a relative link to the exported file
 * (`Roadmap%20abc123….md`) and an absolute notion.so URL ending in the same hex. Anything that does
 * not resolve is LEFT ALONE and counted, the same rule every other source gets — a rewritten guess
 * is worse than a link the reader can see is stale.
 */
// ⚠️ The leading `!` is CAPTURED, not ignored. Without it this matched the `![alt](path)` of an
// EMBED, and a Notion export puts its assets under `Page <32hex>/asset.png` — so the page's own hex
// was found inside the image's PATH and the picture was rewritten into a link to the page containing
// it. The file imported fine and the report said so; only the body pointed somewhere else, which is
// the worst shape a fidelity report can be wrong in. Embeds are resolved by the attachment map, not
// here.
const MD_LINK = /(!?)\[([^\]]*)\]\(([^)\s]+)\)/g
const HEX_ANYWHERE = /([0-9a-f]{32})/i

export function rewriteNotionLinks(
  markdown: string,
  hrefByHex: ReadonlyMap<string, string>,
): { markdown: string; deadLinks: number } {
  let deadLinks = 0
  const out = markdown.replace(MD_LINK, (whole, bang: string, label: string, target: string) => {
    if (bang) return whole // an embed — the attachment map owns it
    if (/^(https?:\/\/(?!(www\.)?notion\.so)|mailto:|wks-attachment:)/i.test(target)) return whole
    const decoded = safeDecode(target)
    const hex = HEX_ANYWHERE.exec(decoded)?.[1]?.toLowerCase()
    if (!hex) return whole
    const href = hrefByHex.get(hex)
    if (!href) { deadLinks++; return whole }
    return `[${label}](${href})`
  })
  return { markdown: out, deadLinks }
}

function safeDecode(s: string): string {
  try { return decodeURIComponent(s) } catch { return s }
}
