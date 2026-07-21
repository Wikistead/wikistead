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
/* #85 / ADR-059: the export document reproduces the EDITOR's look (single design language) so a
   downloaded page reads the same as on-screen — callout colours + icons, heading sizes/colour,
   typography — plus the fidelity indicator on degraded blocks. Self-contained (no external CSS). */
:root{color-scheme:light dark;
  --bg:#ffffff;--fg:#1f2328;--fg-dim:#656d76;--border:#d0d7de;--head:#35a77c;
  --callout-info:#0969da;--callout-note:#57606a;--callout-tip:#2ea043;--callout-warning:#d29922;--callout-danger:#f0584d;
  --font-body:"Inter","Noto Sans JP",system-ui,sans-serif;--font-code:ui-monospace,SFMono-Regular,Menlo,monospace;}
@media (prefers-color-scheme:dark){:root{
  --bg:#1e1e1e;--fg:#dddddd;--fg-dim:#9a9a9a;--border:#3a3a3a;--head:#83c092;
  --callout-info:#4493f8;--callout-note:#9198a1;--callout-tip:#3fb950;--callout-warning:#e3b341;--callout-danger:#f0584d;}}
body{margin:0;background:var(--bg);color:var(--fg);}
.wks-export{max-width:46rem;margin:2rem auto;padding:0 1rem;font-family:var(--font-body);line-height:1.7;}
.wks-export :is(h1,h2,h3,h4,h5,h6){color:var(--head);font-weight:700;line-height:1.3;margin:1.2em 0 .5em;}
.wks-export h1{font-size:1.8em}.wks-export h2{font-size:1.5em}.wks-export h3{font-size:1.3em}
.wks-export h4{font-size:1.15em}.wks-export h5{font-size:1.05em}.wks-export h6{font-size:1em;opacity:.85}
.wks-export-title{color:var(--fg);font-size:2em;margin:0 0 1rem;}
.wks-export img{max-width:100%;height:auto;}
.wks-export a{color:var(--callout-info);}
.wks-export blockquote{margin:.6em 0;border-left:3px solid var(--border);padding-left:.8em;color:var(--fg-dim);}
.wks-export hr{border:none;border-top:2px solid var(--border);margin:1.2em 0;}
.wks-export ul{list-style:disc;padding-left:1.5em;}.wks-export ol{list-style:decimal;padding-left:1.5em;}
.wks-export code{font-family:var(--font-code);background:rgba(127,127,127,.18);border-radius:3px;padding:0 3px;}
.wks-export pre{font-family:var(--font-code);background:rgba(127,127,127,.12);border-radius:6px;padding:.6em .8em;overflow-x:auto;}
.wks-export pre code{background:none;padding:0;}
.wks-export table{border-collapse:collapse;margin:.6em 0;}
.wks-export th,.wks-export td{border:1px solid var(--border);padding:.3em .6em;}
.callout{position:relative;margin:.8em 0;padding:.55em .8em .55em 2.5em;border-radius:6px;border-left:3px solid var(--cb);background:color-mix(in srgb,var(--cb) 8%,transparent);}
.callout::before{content:"";position:absolute;left:.7em;top:.7em;width:1.3em;height:1.3em;background-color:var(--cb);-webkit-mask:var(--cb-icon) center/contain no-repeat;mask:var(--cb-icon) center/contain no-repeat;}
.callout>:first-child{margin-top:0}.callout>:last-child{margin-bottom:0}
.callout-note{--cb:var(--callout-note);--cb-icon:url("data:image/svg+xml,%3Csvg%20xmlns%3D%27http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%27%20viewBox%3D%270%200%2024%2024%27%20fill%3D%27none%27%20stroke%3D%27black%27%20stroke-width%3D%272%27%20stroke-linecap%3D%27round%27%20stroke-linejoin%3D%27round%27%3E%3Cpath%20d%3D%22M21.174%206.812a1%201%200%200%200-3.986-3.987L3.842%2016.174a2%202%200%200%200-.5.83l-1.321%204.352a.5.5%200%200%200%20.623.622l4.353-1.32a2%202%200%200%200%20.83-.497z%22%3E%3C%2Fpath%3E%3Cpath%20d%3D%22m15%205%204%204%22%3E%3C%2Fpath%3E%3C%2Fsvg%3E")}
.callout-info{--cb:var(--callout-info);--cb-icon:url("data:image/svg+xml,%3Csvg%20xmlns%3D%27http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%27%20viewBox%3D%270%200%2024%2024%27%20fill%3D%27none%27%20stroke%3D%27black%27%20stroke-width%3D%272%27%20stroke-linecap%3D%27round%27%20stroke-linejoin%3D%27round%27%3E%3Ccircle%20cx%3D%2212%22%20cy%3D%2212%22%20r%3D%2210%22%3E%3C%2Fcircle%3E%3Cpath%20d%3D%22M12%2016v-4%22%3E%3C%2Fpath%3E%3Cpath%20d%3D%22M12%208h.01%22%3E%3C%2Fpath%3E%3C%2Fsvg%3E")}
.callout-tip{--cb:var(--callout-tip);--cb-icon:url("data:image/svg+xml,%3Csvg%20xmlns%3D%27http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%27%20viewBox%3D%270%200%2024%2024%27%20fill%3D%27none%27%20stroke%3D%27black%27%20stroke-width%3D%272%27%20stroke-linecap%3D%27round%27%20stroke-linejoin%3D%27round%27%3E%3Cpath%20d%3D%22M15%2014c.2-1%20.7-1.7%201.5-2.5%201-.9%201.5-2.2%201.5-3.5A6%206%200%200%200%206%208c0%201%20.2%202.2%201.5%203.5.7.7%201.3%201.5%201.5%202.5%22%3E%3C%2Fpath%3E%3Cpath%20d%3D%22M9%2018h6%22%3E%3C%2Fpath%3E%3Cpath%20d%3D%22M10%2022h4%22%3E%3C%2Fpath%3E%3C%2Fsvg%3E")}
.callout-warning{--cb:var(--callout-warning);--cb-icon:url("data:image/svg+xml,%3Csvg%20xmlns%3D%27http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%27%20viewBox%3D%270%200%2024%2024%27%20fill%3D%27none%27%20stroke%3D%27black%27%20stroke-width%3D%272%27%20stroke-linecap%3D%27round%27%20stroke-linejoin%3D%27round%27%3E%3Cpath%20d%3D%22m21.73%2018-8-14a2%202%200%200%200-3.48%200l-8%2014A2%202%200%200%200%204%2021h16a2%202%200%200%200%201.73-3%22%3E%3C%2Fpath%3E%3Cpath%20d%3D%22M12%209v4%22%3E%3C%2Fpath%3E%3Cpath%20d%3D%22M12%2017h.01%22%3E%3C%2Fpath%3E%3C%2Fsvg%3E")}
.callout-danger{--cb:var(--callout-danger);--cb-icon:url("data:image/svg+xml,%3Csvg%20xmlns%3D%27http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%27%20viewBox%3D%270%200%2024%2024%27%20fill%3D%27none%27%20stroke%3D%27black%27%20stroke-width%3D%272%27%20stroke-linecap%3D%27round%27%20stroke-linejoin%3D%27round%27%3E%3Cpath%20d%3D%22M12%2016h.01%22%3E%3C%2Fpath%3E%3Cpath%20d%3D%22M12%208v4%22%3E%3C%2Fpath%3E%3Cpath%20d%3D%22M15.312%202a2%202%200%200%201%201.414.586l4.688%204.688A2%202%200%200%201%2022%208.688v6.624a2%202%200%200%201-.586%201.414l-4.688%204.688a2%202%200%200%201-1.414.586H8.688a2%202%200%200%201-1.414-.586l-4.688-4.688A2%202%200%200%201%202%2015.312V8.688a2%202%200%200%201%20.586-1.414l4.688-4.688A2%202%200%200%201%208.688%202z%22%3E%3C%2Fpath%3E%3C%2Fsvg%3E")}
.columns{display:flex;gap:1em;flex-wrap:wrap;}.columns>.column{flex:1;min-width:12em;}
/* #422block alignment (:::table{align=} and align= diagram fences). The renderer emits the
   same .cm-lp-align-* wrapper the app uses, but THIS document is self-contained — the app bundle's
   copy of these rules (callout-icons.css, #267) is not loaded here, so without them the wrapper was
   inert and export/print showed no alignment at all. Same semantics as the app's: a column flex box
   whose cross-axis start/end does the aligning (the <table> itself must not become the flex box). */
.cm-lp-align-left{display:flex;flex-direction:column;align-items:flex-start;}
.cm-lp-align-right{display:flex;flex-direction:column;align-items:flex-end;}
.cm-lp-align-center{display:flex;flex-direction:column;align-items:center;}
.tabs>.tab{margin:.5em 0;}.tab-label{margin:0 0 .3em;}
.embed-link{word-break:break-all;}
.wks-fidelity-degrade{position:relative;border:1px dashed color-mix(in srgb,var(--fg-dim) 55%,transparent);border-radius:6px;padding:.4em .6em;margin:.5em 0;}
.wks-fidelity-badge{float:right;margin-left:.5em;color:#b8860b;font-size:1.1em;line-height:1;cursor:help;}
/* #207 part 2: this document IS the print/PDF source (the app prints it from an offscreen frame — the
   whole doc rendered statically, every macro, no raw ::: leak). Make it print well: a compact even
   page margin, and release the narrow on-screen reading column so the print uses the full sheet width
   (#207 part 1's intent, applied on the render path the app actually prints). Force a light surface so
   "Save as PDF" under a dark OS theme still yields black-on-white, not white-on-dark. */
@page{margin:14mm;}
@media print{
  :root{--bg:#ffffff;--fg:#1f2328;--fg-dim:#656d76;--border:#d0d7de;--head:#35a77c;
    --callout-info:#0969da;--callout-note:#57606a;--callout-tip:#2ea043;--callout-warning:#d29922;--callout-danger:#f0584d;}
  .wks-export{max-width:none;margin:0;}
}
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
