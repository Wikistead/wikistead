// #712 / ADR-227 §4 — the Obsidian dialect, as a set of pure transforms over the IR the shared
// importer already builds (ADR-132 §1's ImportSource seam).
//
// An Obsidian vault IS a folder of Markdown, so nothing here re-implements traversal, unzipping, or
// materialisation: the archive still becomes an IR the ordinary way, and these functions rewrite the
// bodies afterwards. That is the whole reason this adapter is small — the seam was cut for it.
//
// What the dialect adds, and what each rule refuses to do quietly:
//   [[Note]] / [[Note|label]]  → a link to the imported note, matched by NAME (case-insensitively,
//                                which is the vault's own resolution rule). Unresolved ones stay as
//                                literal text and are COUNTED — never rewritten to a guessed id.
//   [[Note#heading]]           → the link resolves, the anchor is DROPPED and reported. Our anchors
//                                are generated from headings and a rewritten title changes them; a
//                                wrong anchor is worse than none, and silence is worse than both.
//   ![[image.png]]             → the co-located attachment (the same lookup the `images/` convention
//                                already does).
//   ![[Note]]                  → a LINK plus a degradation entry (ADR-227 ruling 3): the product has
//                                page embedding, but pointing it at an id that only exists mid-import
//                                needs a second pass this slice does not need.
//   YAML frontmatter           → passes through untouched. Obsidian's `tags:` IS this product's tag
//                                notation (ADR-145), so re-deriving it would be inventing a second
//                                path to the same place.
//   .canvas / dataview / %%…%% → reported as degradations. A Dataview block keeps its fenced source
//                                (it renders as text, which is honest); a Canvas file is not a page.
import type { ImportDegradation, ImportNode } from './index.js'

/** A vault note's own name — what `[[…]]` refers to. Obsidian matches on the basename, ignoring case. */
export function noteNameOf(dir: string): string {
  const base = dir.slice(dir.lastIndexOf('/') + 1)
  return base
}

const WIKILINK = /(!?)\[\[([^\]|#]+)(#[^\]|]+)?(?:\|([^\]]*))?\]\]/g

export interface WikilinkResolution {
  /** note name (lower-cased) → the value to put in the link target, already rewritten. */
  hrefByName: Map<string, string>
  /** attachment file name (lower-cased) → the markdown to inline, e.g. `![alt](wks-attachment:id)`. */
  embedByName: Map<string, string>
}

/**
 * Rewrite one node's wikilinks. Pure: every decision is reported rather than logged, so the caller
 * decides what to do with the degradations and the test can read them.
 *
 * `deadLink` counts the links that pointed outside the import — the same treatment `/p/<oldId>`
 * already gets (left as written, counted, and marked by the dead-link UI).
 */
export function rewriteWikilinks(
  markdown: string,
  node: { title: string },
  resolve: WikilinkResolution,
): { markdown: string; degraded: ImportDegradation[]; deadLinks: number } {
  const degraded: ImportDegradation[] = []
  let deadLinks = 0
  const out = markdown.replace(WIKILINK, (whole, bang: string, rawTarget: string, anchor: string | undefined, label: string | undefined) => {
    const target = rawTarget.trim()
    const key = target.toLowerCase()
    const isEmbed = bang === '!'

    if (isEmbed) {
      // An embed of a FILE is an attachment; an embed of a NOTE degrades to a link (ADR-227 ruling 3).
      const inline = resolve.embedByName.get(key)
      if (inline) {
        // ⚠️ `![[pic.png|300]]` carries a DISPLAY SIZE (and `|caption|300` a caption too). The image
        // survives; the sizing does not, because it is Obsidian's own extension rather than anything
        // Markdown says. It used to vanish without a word, which is the same silence the heading
        // anchor was given a report for.
        if (label) degraded.push({ node: node.title, what: 'embed display size or caption dropped', detail: `${target}|${label}` })
        return inline
      }
      const href = resolve.hrefByName.get(key)
      if (href) {
        // The FRAGMENT matters here as much as the note does: `![[Runbook#Rollback]]` becomes a link
        // to the whole page, and a report naming only `Runbook` does not tell the reader that the
        // section they pointed at is the part that was lost.
        degraded.push({ node: node.title, what: 'note embed became a link', detail: `${target}${anchor ?? ''}` })
        return `[${label || target}](${href})`
      }
      deadLinks++
      return whole // neither a known note nor a known file — leave it verbatim, count it
    }

    const href = resolve.hrefByName.get(key)
    if (!href) { deadLinks++; return whole }
    if (anchor) {
      // ⚠️ `#^id` is a BLOCK REFERENCE, not a heading anchor — a different thing that is lost a
      // different way (a heading anchor has an equivalent here; a block id has none at all). Calling
      // both "heading anchor" told the reader the wrong story about what they lost.
      const isBlockRef = anchor.startsWith('#^')
      degraded.push({
        node: node.title,
        what: isBlockRef ? 'wikilink block reference dropped' : 'wikilink heading anchor dropped',
        detail: `${target}${anchor}`,
      })
    }
    return `[${label || target}](${href})`
  })
  return { markdown: out, degraded, deadLinks }
}

// #712H: Obsidian CALLOUTS convert; they do not survive as quotes.
//
// A vault writes `> [!warning] Title` with the body in the same block quote. Left alone, the reader
// of the imported page sees a quote whose first characters are the literal `[!warning]` — the shape
// is lost AND a piece of foreign notation is on screen. This product has the same feature under
// `:::warning[Title]`, so the honest move is to convert rather than to report a loss that need not
// happen. Types Obsidian has and this product does not are folded onto `note` and REPORTED, because
// that one is a real loss of meaning.
const CALLOUT_TYPES = new Map<string, string>([
  ['note', 'note'], ['info', 'info'], ['todo', 'note'], ['abstract', 'note'], ['summary', 'note'],
  ['tip', 'tip'], ['hint', 'tip'], ['important', 'tip'], ['success', 'tip'], ['check', 'tip'], ['done', 'tip'],
  ['question', 'note'], ['help', 'note'], ['faq', 'note'], ['example', 'note'], ['quote', 'note'], ['cite', 'note'],
  ['warning', 'warning'], ['caution', 'warning'], ['attention', 'warning'],
  ['danger', 'danger'], ['error', 'danger'], ['failure', 'danger'], ['fail', 'danger'], ['missing', 'danger'], ['bug', 'danger'],
])
const CALLOUT_HEAD = /^(\s*)>\s*\[!([A-Za-z]+)\]([+-]?)\s*(.*)$/

export function convertVaultCallouts(
  markdown: string,
  node: { title: string },
): { markdown: string; degraded: ImportDegradation[] } {
  const degraded: ImportDegradation[] = []
  const lines = markdown.split('\n')
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const head = CALLOUT_HEAD.exec(lines[i]!)
    if (!head) { out.push(lines[i]!); continue }
    const [, , rawType, fold, title] = head
    const kind = rawType!.toLowerCase()
    const mapped = CALLOUT_TYPES.get(kind)
    if (!mapped) { out.push(lines[i]!); continue } // not a callout we recognise — leave the quote alone
    if (mapped === 'note' && kind !== 'note') {
      degraded.push({ node: node.title, what: `callout type "${kind}" has no equivalent — shown as a note`, detail: kind })
    }
    if (fold) {
      // `>[!note]-` is a COLLAPSED callout. The panel here does not fold, so say so rather than let
      // a reader wonder why the page is longer than it was.
      degraded.push({ node: node.title, what: 'collapsible callout is shown expanded', detail: kind })
    }
    // Consume the rest of the block quote as the body.
    const body: string[] = []
    let j = i + 1
    for (; j < lines.length; j++) {
      const cont = /^\s*>\s?(.*)$/.exec(lines[j]!)
      if (!cont) break
      body.push(cont[1]!)
    }
    out.push(`:::${mapped}${title ? `[${title.trim()}]` : ''}`)
    out.push(...body)
    out.push(':::')
    i = j - 1
  }
  return { markdown: out.join('\n'), degraded }
}

/**
 * Vault shapes that have no representation here. Reported per node so the import's own report can
 * name them; the body is left alone (a Dataview fence renders as its source, which is honest).
 */
export function detectVaultDegradations(node: { title: string; markdown: string }): ImportDegradation[] {
  const out: ImportDegradation[] = []
  const fences = node.markdown.match(/^```(dataview|dataviewjs)\b/gm)
  if (fences) {
    out.push({
      node: node.title,
      what: 'Dataview query kept as source',
      detail: `${fences.length} block(s) — the query text is preserved and renders as a code block`,
    })
  }
  if (/%%[\s\S]*?%%/.test(node.markdown)) {
    out.push({ node: node.title, what: 'Obsidian comment (%%…%%) kept as text' })
  }
  // ⚠️ The INLINE form was reported nowhere while the fenced one was — an asymmetry that made the
  // report look complete on a vault that used the short form.
  const inlineDv = node.markdown.match(/`=[^`\n]+`/g)
  if (inlineDv) {
    out.push({
      node: node.title,
      what: 'inline Dataview expression kept as text',
      detail: `${inlineDv.length} expression(s)`,
    })
  }
  // A block id is Obsidian's anchor for "this paragraph". Nothing here refers to it, so it stays in
  // the text as a stray `^id` — visible to the reader and meaningless, which is worth saying.
  const blockIds = node.markdown.match(/(?:^|\s)\^[A-Za-z0-9-]+\s*$/gm)
  if (blockIds) {
    out.push({
      node: node.title,
      what: 'block identifier (^id) left in the text',
      detail: `${blockIds.length} paragraph(s)`,
    })
  }
  return out
}

/** `.canvas` files are not pages — reported once per file rather than silently skipped. */
export function canvasDegradations(fileNames: readonly string[]): ImportDegradation[] {
  return fileNames
    .filter((n) => n.toLowerCase().endsWith('.canvas'))
    .map((n) => ({ node: n, what: 'Canvas file not imported', detail: 'Canvas has no Markdown representation' }))
}

/**
 * Serialise adapter-supplied frontmatter back onto the body. Only used when a node CARRIES
 * frontmatter the adapter parsed out; the ordinary Obsidian path leaves the block untouched in the
 * text, which is why this stays conservative — it never rewrites an existing block.
 */
export function withFrontmatter(markdown: string, frontmatter: Record<string, unknown> | undefined): string {
  if (!frontmatter || Object.keys(frontmatter).length === 0) return markdown
  if (/^---\r?\n/.test(markdown)) return markdown // the body already has its own block; leave it
  const lines = Object.entries(frontmatter).map(([k, v]) =>
    Array.isArray(v) ? `${k}: [${v.map((x) => String(x)).join(', ')}]` : `${k}: ${String(v)}`)
  return `---\n${lines.join('\n')}\n---\n\n${markdown}`
}

/**
 * A vault's attachments live in ONE folder (`attachments/`, or wherever the vault is configured to
 * put them) rather than beside each note the way the Wikistead export does — so the shared builder,
 * which only collects `<dir>/images/`, finds none of them. Measured on a real vault: `![[diagram.png]]`
 * resolved to nothing because the file had never been read.
 *
 * This collects every file the import did NOT turn into a page or already claim as an attachment, so
 * `![[…]]` has something to resolve against. They are handed to the FIRST root node purely so the
 * existing materializer uploads them through its own quota + sniff gate (ADR-132 §3) — the embed map
 * is built across all nodes, so which node carries them does not affect resolution.
 */
export function vaultAttachments(
  files: Record<string, Uint8Array>,
  opts: { claimed: ReadonlySet<string>; mimeOf: (name: string) => string },
): { relPath: string; name: string; bytes: Uint8Array; mime: string }[] {
  const out: { relPath: string; name: string; bytes: Uint8Array; mime: string }[] = []
  for (const [path, bytes] of Object.entries(files)) {
    if (opts.claimed.has(path)) continue
    const lower = path.toLowerCase()
    // Pages, the manifest and Canvas files are not attachments. A `.canvas` is reported separately;
    // importing it as a binary blob would be the silent-drop behaviour wearing a different hat.
    if (lower.endsWith('.md') || lower.endsWith('.canvas') || path === 'manifest.json') continue
    const name = path.slice(path.lastIndexOf('/') + 1)
    if (!name) continue
    out.push({ relPath: path, name, bytes, mime: opts.mimeOf(name) })
  }
  return out
}

/** Every node in an IR tree, depth-first — adapters walk the same shape the materializer does. */
export function walkNodes(roots: readonly ImportNode[]): ImportNode[] {
  const out: ImportNode[] = []
  const visit = (n: ImportNode) => { out.push(n); n.children.forEach(visit) }
  roots.forEach(visit)
  return out
}
