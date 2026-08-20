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
  // ⚠️ `information` is the class Confluence's own "Info" macro emits
  // (`confluence-information-macro-information`), and it is the one people use most. Mapping `info`
  // and not `information` meant the most common macro in a real export was the one that came out as
  // an unrepresentable block quote while its rarer siblings converted cleanly.
  ['info', 'note'], ['information', 'note'], ['note', 'note'], ['tip', 'tip'],
  ['warning', 'warning'], ['panel', 'note'],
])

interface Ctx {
  degraded: ImportDegradation[]
  title: string
  /** Lower-cased page names the ARCHIVE carries — a link outside this set cannot become a wikilink. */
  pageNames: ReadonlySet<string>
  /** storage-format labels already reported for THIS page — see `reportStorage` */
  storageSeen: Set<string>
}

// #712 ③ — STORAGE FORMAT, the input this adapter does not read.
//
// ADR-227 §6 scoped Confluence to the HTML export; the XML/storage format stayed out on purpose. But
// an archive can still carry storage markup — `<ac:structured-macro ac:name="jira">` and friends turn
// up inside HTML exports of older instances, and people hand this converter what their admin console
// gave them rather than what an ADR chose. Those tags matched nothing in the walk below, so they fell
// to `default:` and were flattened to their inner text: a jira macro left the string `ENG-1` sitting
// in a paragraph, with an EMPTY report. That is the one failure ADR-227 exists to prevent — not that
// the element was unsupported, but that the archive was told nothing about it.
//
// WHY REPORT RATHER THAN REFUSE (the decision behind #712 ③): a Confluence export is one archive of
// several hundred pages. Rejecting all of it because one page carries `ac:` markup costs the reader
// the 499 pages that would have imported cleanly, and they did not choose which format their admin
// console produced — so a refusal leaves them with no next move, in the ticket whose whole purpose is
// removing the friction of moving. Reporting keeps the pages, keeps the text, and names what this
// adapter could not read. The SCOPE is unchanged: storage format is still not converted. It is now
// declared instead of swallowed.
const STORAGE_PREFIXES = ['ac:', 'ri:']
const isStorageTag = (tag: string) => STORAGE_PREFIXES.some((p) => tag.startsWith(p))

/** What to call this element in the report: the macro's own name where it has one, else the tag. */
function storageLabel(el: HTMLElement, tag: string): string {
  if (tag === 'ac:structured-macro') {
    const name = el.getAttribute('ac:name')
    if (name) return name.toLowerCase()
  }
  // `<ac:image><ri:attachment ri:filename="pic.png"/></ac:image>` — the file is IN the archive, so
  // naming it is the difference between "something was lost" and "go and look at pic.png".
  const file = attachmentFilename(el)
  return file ? `${tag} (${file})` : tag
}

function attachmentFilename(el: HTMLElement): string | null {
  const own = el.getAttribute('ri:filename')
  if (own) return own
  for (const child of el.childNodes) {
    const found = (child as HTMLElement).rawTagName ? attachmentFilename(child as HTMLElement) : null
    if (found) return found
  }
  return null
}

/**
 * Report a storage-format element, ONCE per label per page.
 *
 * Deduplicated because a page migrated from an older instance can carry the same `ac:link` forty
 * times, and forty identical rows do not tell the reader anything the first one did not — they bury
 * the other findings, which is its own way of losing them.
 */
function reportStorage(el: HTMLElement, tag: string, ctx: Ctx): void {
  const detail = storageLabel(el, tag)
  // The key is JSON rather than a joined string with a delimiter. The obvious delimiter here is
  // NUL, and writing one puts a raw NUL BYTE in this source file — which makes the file binary
  // to git, so it can no longer be diffed or reviewed. (Nine files in this tree are already in
  // that state; filed separately.)
  const key = JSON.stringify([ctx.title, detail])
  if (ctx.storageSeen.has(key)) return
  ctx.storageSeen.add(key)
  ctx.degraded.push({ node: ctx.title, code: 'confluenceStorageFormat',
    what: 'Confluence storage-format markup not converted', detail, params: { name: detail } })
}

/**
 * Convert one exported page's HTML body into Markdown.
 *
 * Everything with an obvious Markdown form is converted; a Confluence macro without one becomes a
 * LABELLED block quote naming the macro, and is reported. Silent deletion is the single thing this
 * must never do — a migration that quietly drops a jira macro is how a wiki loses its own history.
 */
export function confluenceHtmlToMarkdown(html: string, title: string, pageNames: ReadonlySet<string> = new Set()): { markdown: string; degraded: ImportDegradation[] } {
  const ctx: Ctx = { degraded: [], title, pageNames, storageSeen: new Set() }
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
  // Before the walk, not inside `default:` — a storage element can be spelled `ac:layout` and would
  // otherwise be indistinguishable from an ordinary unknown container that is fine to flatten.
  if (isStorageTag(tag)) return renderStorage(el, tag, ctx)
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
      return image(el, ctx)
    case 'script': case 'style':
      return ''
    default:
      return children(el, ctx).join('\n\n') || inline(el, ctx).trim()
  }
}

/**
 * A storage-format element: reported, and its text kept under a label saying what it was.
 *
 * The marker is the SAME shape the HTML export's unrepresentable macros already use, so a reader
 * meeting both in one import learns one convention rather than two. What differs is the `what` in
 * the report, because the two situations are genuinely different: one is a macro this product has no
 * equivalent for, the other is markup this adapter does not read at all.
 */
function renderStorage(el: HTMLElement, tag: string, ctx: Ctx): string {
  reportStorage(el, tag, ctx)
  const label = storageLabel(el, tag)
  // The children are walked normally: text inside a storage macro is still the author's text, and
  // dropping it here would be exactly the silent loss this branch was added to stop. Nested storage
  // elements report themselves on the way through (deduplicated), so a wrapper does not hide them.
  const inner = children(el, ctx).join('\n\n').trim()
  return inner ? `> [Confluence storage format: ${label}]\n>\n${inner.split('\n').map((l) => `> ${l}`).join('\n')}`
    : `> [Confluence storage format: ${label}]`
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
  ctx.degraded.push({ node: ctx.title, code: 'confluenceMacroNoEquivalent',
    what: 'Confluence macro has no equivalent', detail: macro, params: { macro } })
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
  // ⚠️ A Confluence TASK LIST is a `<ul class="inline-task-list">` whose items carry `checked`.
  // Rendering it as a plain bullet list threw away both the checkbox and whether it was done — this
  // product has GFM task lists, so the shape has somewhere to go.
  const isTasks = /(^|\s)inline-task-list(\s|$)/.test(el.getAttribute('class') ?? '')
  return items.map((li, i) => {
    const nested = li.querySelectorAll('> ul, > ol')
    const own = inline(li, ctx, nested).trim()
    const marker = isTasks
      ? `- [${/(^|\s)checked(\s|$)/.test(li.getAttribute('class') ?? '') ? 'x' : ' '}]`
      : ordered ? `${i + 1}.` : '-'
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
    ctx.degraded.push({ node: ctx.title, code: 'mergedCellsFlattened',
      what: 'merged table cells flattened', detail: 'GFM tables have no rowspan/colspan' })
  }
  return out.join('\n')
}

// #712 ④ (user ruling 2026-08-19): Confluence emoticons become the ACTUAL CHARACTER.
//
// They arrive as `<img class="emoticon" alt="smile" src="/images/icons/emoticons/smile.png">`: a picture
// hosted by the instance being left, so carried over verbatim it is a broken image on every page that
// used one. replaced it with the alt text as `:smile:` — which this product does not render (no
// shortcode pass exists in the editor or the renderers), so the reader saw the literal colons.
//
// The set is small and fixed, so it maps to Unicode instead: a standard character, in the body, that
// needs no renderer and survives an export. A mapped one is NOT reported — nothing was lost. Only a
// name outside this table falls back to `:name:` and is reported, which is the honest half of.
const EMOTICONS: Record<string, string> = {
  smile: '🙂', sad: '🙁', wink: '😉', laugh: '😄', cheeky: '😜',
  'thumbs-up': '👍', 'thumbs-down': '👎',
  tick: '✅', cross: '❌', warning: '⚠️', information: 'ℹ️', question: '❓',
  'light-on': '💡', 'light-off': '🔅', 'yellow-star': '⭐', 'red-star': '⭐',
  'green-star': '⭐', 'blue-star': '⭐', heart: '❤️', broken: '💔',
  plus: '➕', minus: '➖', check: '✅', flag: '🚩', 'star-yellow': '⭐',
}

function image(el: HTMLElement, ctx?: Ctx): string {
  const src = el.getAttribute('src') ?? ''
  const alt = el.getAttribute('alt') ?? ''
  if (!src) return ''
  // ⚠️ Confluence renders EMOJI as `<img>` pointing into its own installation
  // (`/images/icons/emoticons/smile.png`, or an absolute URL at the old host). Carried over verbatim
  // those become broken images on every page that used one — and the alt text is usually the emoji's
  // name, which reads better than a missing picture. So the picture is dropped for the name, and the
  // substitution is REPORTED rather than done quietly.
  const byPath = /(^|\/)(images\/icons\/emoticons|emoticons)\//i.test(src)
    || /^https?:\/\/[^/]+\/(?:wiki\/)?images\/icons\//i.test(src)
  // Those two paths are the Server / Data Center shape. asked, without being able to measure
  // it, whether Cloud's emoji reach them — they do not: Cloud serves emoji from an emoji CDN under a
  // host this rule has never heard of, so a Cloud export would keep the `<img>` and hotlink Atlassian
  // forever. The one thing BOTH vintages say about the picture is that it IS an emoji, and they say
  // it in the class, so that is what the second arm reads: no hostname is invented to match.
  // It is deliberately narrowed to a REMOTE src — a class-tagged picture the export actually carries
  // still becomes an image, because that one survives the import and there is nothing to repair.
  const byClass = /(^|\s)(emoji|emoticon)(-[\w-]+)?(\s|$)/i.test(el.getAttribute('class') ?? '')
    && /^https?:\/\//i.test(src)
  if (byPath || byClass) {
    // Confluence writes the emoji's name into `alt` in two spellings depending on the export's
    // vintage: bare (`smile`) and already wrapped in colons (`:smile:`). Matching only the bare one
    // failed twice over on the wrapped one — the table lookup missed a name that IS in the table,
    // and the fallback then wrapped it a second time, so the reader got `::smile::`. The name is
    // normalised once, here, and everything below reads the normalised form.
    const name = alt.trim().replace(/^:+/, '').replace(/:+$/, '')
    const key = name.toLowerCase()
    const glyph = EMOTICONS[key] ?? EMOTICONS[key.replace(/[_ ]/g, '-')]
    if (glyph) return glyph // mapped: nothing lost, so nothing to report
    ctx?.degraded.push({ node: ctx.title, code: 'emojiReplacedByName',
      what: 'emoji image replaced by its name', detail: name || src, params: { name: name || src } })
    return name ? `:${name}:` : ''
  }
  return `![${alt}](${src})`
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
  // The same declaration, from the inline side. A `<ac:link>` sits inside a paragraph, so it never
  // reaches `renderBlock` — and `default:` below flattens it to its text with nothing said, which is
  // how a page's links quietly become words. No block-quote marker here (it would break the
  // sentence): the text is kept, and the report carries the name.
  if (isStorageTag(tag)) {
    reportStorage(el, tag, ctx)
    return inline(el, ctx)
  }
  switch (tag) {
    case 'strong': case 'b': return `**${inline(el, ctx).trim()}**`
    case 'em': case 'i': return `*${inline(el, ctx).trim()}*`
    // ⚠️ GFM has strikethrough, so losing it was a plain omission rather than a limitation: the text
    // came through with the line silently removed, which changes what the sentence means.
    case 's': case 'del': case 'strike': return `~~${inline(el, ctx).trim()}~~`
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
        // ⚠️ The wikilink is an INTERNAL hand-off to the shared resolver, not something a reader may
        // ever see. When the target is outside the import the resolver leaves the text alone, and an
        // unresolved `[[Gone|gone]]` then sits in the page as notation this product does not even
        // parse. So the fallback is registered here: `ctx.unresolved` records the shape, and
        // `settleWikilinks` below turns whatever the resolver did not claim back into plain text.
        // ⚠️ ONLY when the archive really carries that page. The wikilink is an internal hand-off to
        // the shared resolver; when the target is outside the import the resolver correctly leaves it
        // alone, and an unresolved `[[Gone|gone]]` then sits in the page as notation THIS PRODUCT
        // DOES NOT PARSE — a Confluence import writing Obsidian syntax at the reader. So a link to a
        // page the export does not contain becomes plain text, and is reported.
        if (ctx.pageNames.has(leaf.toLowerCase())) return `[[${leaf}|${text}]]`
        ctx.degraded.push({ node: ctx.title, code: 'linkOutsideExport',
          what: 'link to a page outside the export', detail: leaf, params: { target: leaf } })
        return text
      }
      // ⚠️ An `<a href="attachments/…">` is a FILE, not a page. It is left exactly as written here and
      // re-pointed during materialisation (`rewriteBody`), where the attachment id exists — the same
      // place the image pass resolves the same files. Reporting it as lost from here would be a
      // prediction, and after #712 leftover ① it would be a wrong one: what cannot be resolved is
      // reported there, from the fact rather than from the guess.
      return `[${text}](${href})`
    }
    case 'img': return image(el, ctx)
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
