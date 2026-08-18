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
      if (inline) return inline
      const href = resolve.hrefByName.get(key)
      if (href) {
        degraded.push({ node: node.title, what: 'note embed became a link', detail: target })
        return `[${label || target}](${href})`
      }
      deadLinks++
      return whole // neither a known note nor a known file — leave it verbatim, count it
    }

    const href = resolve.hrefByName.get(key)
    if (!href) { deadLinks++; return whole }
    if (anchor) {
      degraded.push({ node: node.title, what: 'wikilink heading anchor dropped', detail: `${target}${anchor}` })
    }
    return `[${label || target}](${href})`
  })
  return { markdown: out, degraded, deadLinks }
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
