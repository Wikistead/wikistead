// #712 / ADR-227 §6 — the Confluence dialect.
//
// INPUT: the HTML export (owner ruling, ADR-227 §6). The XML backup is an internal schema spread
// across many files with attachments keyed separately; a REST importer would put credentials and an
// outbound fetch into a path that today only reads bytes the user handed us, and that is refused on
// purpose rather than by omission.
//
// CONVERSION HAPPENS HERE. ADR-132 §3's rule is that the IR carries Markdown only, so no raw HTML
// ever reaches a page body — an imported Confluence page is as inert as anything else the moment it
// lands, because what landed is Markdown.
//
// The converter walks a PARSED TREE (node-html-parser, MIT — chosen over turndown, which needs a DOM
// implementation and would drag jsdom into the server for one import path). Regex over raw HTML was
// never an option: it is how a converter starts eating its own angle brackets, and §6 says parsed.
import { parse, type HTMLElement, type Node } from 'node-html-parser'
import type { ImportDegradation } from './index.js'

/** True when the archive looks like a Confluence HTML export (its own index + page files). */
export function looksLikeConfluenceExport(paths: readonly string[]): boolean {
  const lower = paths.map((p) => p.toLowerCase())
  const hasHtml = lower.some((p) => p.endsWith('.html') || p.endsWith('.htm'))
  return hasHtml && lower.some((p) => /(^|\/)(index|main)\.html?$/.test(p) || /(^|\/)attachments\//.test(p))
}

const BLOCK_MACROS = new Map<string, string>([
  ['info', 'note'], ['note', 'note'], ['tip', 'tip'], ['warning', 'warning'], ['panel', 'note'],
])

interface Ctx {
  degraded: ImportDegradation[]
  title: string
}

/**
 * Convert one exported page's HTML body into Markdown.
 *
 * Everything with an obvious Markdown form is converted; a Confluence macro without one becomes a
 * LABELLED block quote naming the macro, and is reported. Silent deletion is the single thing this
 * must never do — a migration that quietly drops a jira macro is how a wiki loses its own history.
 */
export function confluenceHtmlToMarkdown(html: string, title: string): { markdown: string; degraded: ImportDegradation[] } {
  const ctx: Ctx = { degraded: [], title }
  const root = parse(html, { blockTextElements: { script: false, style: false, pre: true, code: true } })
  // The export wraps the real content; fall back to the whole document when the wrapper is absent.
  const body = root.querySelector('#main-content') ?? root.querySelector('body') ?? root
  const md = children(body, ctx).join('\n\n').replace(/\n{3,}/g, '\n\n').trim()
  return { markdown: md ? `${md}\n` : '', degraded: ctx.degraded }
}

function children(el: HTMLElement, ctx: Ctx): string[] {
  const out: string[] = []
  for (const node of el.childNodes) {
    const block = renderBlock(node, ctx)
    if (block && block.trim()) out.push(block.trim())
  }
  return out
}

function renderBlock(node: Node, ctx: Ctx): string {
  const el = node as HTMLElement
  const tag = (el.rawTagName ?? '').toLowerCase()
  if (!tag) {
    const text = inlineText(node).trim()
    return text
  }
  switch (tag) {
    case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6':
      return `${'#'.repeat(Number(tag[1]))} ${inline(el, ctx).trim()}`
    case 'p':
      return inline(el, ctx).trim()
    case 'ul': case 'ol':
      return list(el, ctx, tag === 'ol')
    case 'pre': {
      const code = el.querySelector('code')
      const lang = codeLanguage(el)
      return `\`\`\`${lang}\n${(code ?? el).text.replace(/\n+$/, '')}\n\`\`\``
    }
    case 'table':
      return table(el, ctx)
    case 'blockquote':
      return children(el, ctx).map((l) => `> ${l}`).join('\n>\n')
    case 'hr':
      return '---'
    case 'br':
      return ''
    case 'div': case 'section': case 'article': case 'span': {
      const macro = macroOf(el)
      if (macro) return renderMacro(el, macro, ctx)
      return children(el, ctx).join('\n\n')
    }
    case 'img':
      return image(el)
    case 'script': case 'style':
      return ''
    default:
      return children(el, ctx).join('\n\n') || inline(el, ctx).trim()
  }
}

/** Confluence marks its macros on the wrapper; both export vintages are handled. */
function macroOf(el: HTMLElement): string | null {
  const name = el.getAttribute('data-macro-name')
  if (name) return name.toLowerCase()
  const cls = el.getAttribute('class') ?? ''
  const m = /(?:^|\s)(?:confluence-information-macro-)(\w+)/.exec(cls)
  if (m) return m[1]!.toLowerCase()
  if (/(?:^|\s)code(?:$|\s)/.test(cls) && el.querySelector('pre')) return 'code'
  return null
}

function renderMacro(el: HTMLElement, macro: string, ctx: Ctx): string {
  const directive = BLOCK_MACROS.get(macro)
  if (directive) {
    const inner = children(el, ctx).join('\n\n').trim()
    return `:::${directive}\n${inner}\n:::`
  }
  if (macro === 'code') {
    const pre = el.querySelector('pre')
    if (pre) return `\`\`\`${codeLanguage(el)}\n${pre.text.replace(/\n+$/, '')}\n\`\`\``
  }
  if (macro === 'toc') return ':::toc\n:::'
  // No Markdown form: keep a labelled marker so the reader sees WHAT was there, and report it.
  ctx.degraded.push({ node: ctx.title, what: 'Confluence macro has no equivalent', detail: macro })
  const inner = children(el, ctx).join('\n\n').trim()
  return inner ? `> [Confluence macro: ${macro}]\n>\n${inner.split('\n').map((l) => `> ${l}`).join('\n')}`
    : `> [Confluence macro: ${macro}]`
}

function codeLanguage(el: HTMLElement): string {
  // Confluence puts `brush: bash` on the <pre> itself; older exports put `language-x` on the <code>,
  // and the macro wrapper sometimes carries neither. Look at all three rather than guess which
  // vintage produced the archive (measured: only the wrapper was consulted, so every fence came out
  // language-less even though the export said `brush: bash`).
  const cls = [
    el.getAttribute('class') ?? '',
    el.querySelector('pre')?.getAttribute('class') ?? '',
    el.querySelector('code')?.getAttribute('class') ?? '',
  ].join(' ')
  const m = /brush:\s*([a-z0-9+#-]+)|language-([a-z0-9+#-]+)/i.exec(cls)
  return (m?.[1] ?? m?.[2] ?? '').toLowerCase()
}

function list(el: HTMLElement, ctx: Ctx, ordered: boolean): string {
  const items = el.querySelectorAll('> li')
  return items.map((li, i) => {
    const nested = li.querySelectorAll('> ul, > ol')
    const own = inline(li, ctx, nested).trim()
    const marker = ordered ? `${i + 1}.` : '-'
    const sub = nested.map((n) => list(n, ctx, (n.rawTagName ?? '').toLowerCase() === 'ol')
      .split('\n').map((l) => `  ${l}`).join('\n')).join('\n')
    return sub ? `${marker} ${own}\n${sub}` : `${marker} ${own}`
  }).join('\n')
}

function table(el: HTMLElement, ctx: Ctx): string {
  const rows = el.querySelectorAll('tr')
  if (!rows.length) return ''
  const cellsOf = (tr: HTMLElement) => tr.querySelectorAll('th, td')
    .map((c) => inline(c, ctx).replace(/\|/g, '\\|').replace(/\n+/g, ' ').trim())
  const header = cellsOf(rows[0]!)
  const out = [`| ${header.join(' | ')} |`, `|${header.map(() => '---').join('|')}|`]
  for (const tr of rows.slice(1)) {
    const cells = cellsOf(tr)
    while (cells.length < header.length) cells.push('')
    out.push(`| ${cells.slice(0, header.length).join(' | ')} |`)
  }
  // A merged cell cannot survive a GFM pipe table — say so rather than let the row silently shift.
  if (el.querySelector('[colspan], [rowspan]')) {
    ctx.degraded.push({ node: ctx.title, what: 'merged table cells flattened', detail: 'GFM tables have no rowspan/colspan' })
  }
  return out.join('\n')
}

function image(el: HTMLElement): string {
  const src = el.getAttribute('src') ?? ''
  const alt = el.getAttribute('alt') ?? ''
  return src ? `![${alt}](${src})` : ''
}

/** Inline rendering for a container's own text, optionally skipping nested blocks. */
function inline(el: HTMLElement, ctx: Ctx, skip: readonly HTMLElement[] = []): string {
  let out = ''
  for (const node of el.childNodes) {
    if (skip.includes(node as HTMLElement)) continue
    out += inlineNode(node, ctx)
  }
  return out
}

function inlineNode(node: Node, ctx: Ctx): string {
  const el = node as HTMLElement
  const tag = (el.rawTagName ?? '').toLowerCase()
  if (!tag) return inlineText(node)
  switch (tag) {
    case 'strong': case 'b': return `**${inline(el, ctx).trim()}**`
    case 'em': case 'i': return `*${inline(el, ctx).trim()}*`
    case 'code': return `\`${el.text}\``
    case 'a': {
      const href = el.getAttribute('href') ?? ''
      const text = inline(el, ctx).trim() || href
      if (!href) return text
      // An export's page links point at `Other page.html`. Left alone they would all break, since
      // the pages become Wikistead ids. Rewriting them to `[[Other page|label]]` hands them to the
      // SAME resolver the vault dialect uses (ADR-227 §3: one link path, three sources) — and an
      // unresolvable one then gets the shared treatment, left literal and counted.
      const internal = /^(?!https?:|mailto:|#)([^?#]+)\.html?(?:[?#].*)?$/i.exec(decodeSafe(href))
      if (internal) {
        const base = internal[1]!
        const leaf = base.slice(base.lastIndexOf('/') + 1)
        return `[[${leaf}|${text}]]`
      }
      return `[${text}](${href})`
    }
    case 'img': return image(el)
    case 'br': return '\n'
    case 'ul': case 'ol': return `\n${list(el, ctx, tag === 'ol')}\n`
    default: return inline(el, ctx)
  }
}

function decodeSafe(s: string): string {
  try { return decodeURIComponent(s) } catch { return s }
}

function inlineText(node: Node): string {
  // `text` on a text node is the raw content; collapse the export's pretty-printing whitespace.
  return (node.text ?? '').replace(/\s+/g, ' ')
}
