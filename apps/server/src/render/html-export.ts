import type { OpenFgaClient } from '@openfga/sdk'
import { check } from '@wikistead/authz'
import { renderMarkdownToHtml, builtinMacroRegistry, escapeHtml } from '@wikistead/macro-render'
import type { TenantDb } from '../db/index.js'
import { sanitizeExportHtml } from './sanitize.js'

// #85 / ADR-059 slice 3b: the server-side HTML export route body. This is the ONE
// `render → sanitize` path (no export-only shortcut) — SSR / public / search snippets will call the
// same function later. Like the Markdown export it renders the PUBLISHED version (pages.published_md),
// never the live draft, and is view-gated: an unviewable root is null → the route returns 404 (no
// existence leak). Rendering runs through the shared DOM-free macro renderer (single source of truth
// with the editor), then EVERYTHING passes the final sanitizer — the only trust boundary.

export interface HtmlExportResult {
  filename: string
  contentType: string
  body: string
}

interface PageRow {
  title: string | null
  published_md: string | null
}

// A minimal, server-controlled document skeleton. The body is already sanitized; the title is
// escaped here (it's the only dynamic value in the static shell). Class-only styling hooks are left
// for the published/static stylesheet (slice 4) — no inline style (ADR-059 decision-4). The document
// carries a small STATIC stylesheet (server-authored, not user content) so the export is readable
// standalone AND the per-block fidelity indicator (#85 (c) / ADR-059) is visible: a `degrade` macro is
// wrapped by withFidelity in `.wks-fidelity-degrade` with a `.wks-fidelity-badge` ◐, which the reader
// needs to actually SEE to know a block was simplified for export.
const EXPORT_STYLES = `
:root { color-scheme: light dark; }
.wks-export { max-width: 46rem; margin: 2rem auto; padding: 0 1rem; font-family: system-ui, sans-serif; line-height: 1.6; }
.wks-export-title { margin: 0 0 1rem; }
.wks-export img { max-width: 100%; height: auto; }
.wks-export pre { overflow-x: auto; padding: .6em .8em; background: rgba(127,127,127,.12); border-radius: 6px; }
.wks-export code { background: rgba(127,127,127,.18); border-radius: 3px; padding: 0 3px; }
.wks-export blockquote { margin: 0; padding-left: .8em; border-left: 3px solid rgba(127,127,127,.5); }
.wks-export table { border-collapse: collapse; }
.wks-export th, .wks-export td { border: 1px solid rgba(127,127,127,.4); padding: .3em .5em; }
.wks-export .callout { border: 1px solid rgba(127,127,127,.4); border-radius: 6px; padding: .5em .8em; margin: .5em 0; }
/* #85 (c): the fidelity indicator for a block simplified (degraded) on export. */
.wks-fidelity-degrade { position: relative; border: 1px dashed rgba(127,127,127,.55); border-radius: 6px; padding: .4em .6em; margin: .5em 0; }
.wks-fidelity-badge { float: right; margin-left: .5em; color: #b8860b; font-size: 1.1em; line-height: 1; cursor: help; }
`

function htmlDocument(title: string, safeBody: string): string {
  const t = escapeHtml(title || 'Untitled')
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${t}</title>
<style>${EXPORT_STYLES}</style>
</head>
<body>
<main class="wks-export">
<h1 class="wks-export-title">${t}</h1>
${safeBody}
</main>
</body>
</html>
`
}

// Build a single-page HTML export. Authorization mirrors the Markdown export: the page must be
// viewable (else null → 404). Subtree bundling + image inlining are slice 4; this is the single page
// through the shared render→sanitize path.
export async function buildHtmlExport(
  db: TenantDb,
  fga: OpenFgaClient,
  args: { userId: string; pageId: string },
): Promise<HtmlExportResult | null> {
  if (!(await check(fga, `user:${args.userId}`, 'view', { type: 'page', id: args.pageId }))) return null

  const [row] = await db.sql<PageRow[]>`SELECT title, published_md FROM pages WHERE id = ${args.pageId}`
  if (!row) return null // viewable per FGA but gone from the tenant table → 404 (no leak)

  // Shared renderer (single source of truth with the editor) → SafeHtml, then the final sanitizer.
  // renderMarkdownToHtml already produces SafeHtml (dynamic values escaped; `:::table` uses the
  // table-model allowlist), but the sanitizer re-checks the WHOLE output so raw passthrough is zero.
  const rendered = renderMarkdownToHtml(row.published_md ?? '', builtinMacroRegistry())
  const safeBody = sanitizeExportHtml(rendered.value)

  const title = row.title ?? 'Untitled'
  return {
    filename: `${title}.html`,
    contentType: 'text/html; charset=utf-8',
    body: htmlDocument(title, safeBody),
  }
}
