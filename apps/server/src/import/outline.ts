// #728 / ADR-242 §3 — the Outline dialect.
//
// Measured against an archive Outline 1.9.2 actually produced (a collection export in Markdown,
// written by `ExportMarkdownZipTask`, the class the product's own export button reaches), not against
// its source. Three of the things ADR-242 read out of `ExportDocumentTreeTask.ts` are not what a real
// archive holds, and every one of them is a way for an adapter to work in English and fail in
// Japanese:
//
//   1. A LINK IS PERCENT-ENCODED TWICE, THE ENTRY NAME ONCE. The exporter puts `%2F` in the file name
//      where the title had `/`, and then runs `encodeURI` over the relative path — which encodes the
//      `%` of that `%2F` again:
//        entry  Handbook/Handbook/<title with a raw slash escaped as %2F>.md
//        link   ./Handbook/%E9%81%8B…%20%252F%20…%E6%AC%A1.md
//      Decoding ONCE gives the entry name. Decoding to a plain string gives a name with a `/` in it,
//      which is a different (and absent) path. Measured both ways: once hits, twice misses.
//
//   2. THE REWRITE ONLY FIRES ON THE SLUG FORM. The exporter's own regular expression matches a bare
//      `/doc/<id>`, but the map it then consults is keyed on the full `/doc/<slug>-<id>` the product
//      writes. A body carrying the bare form therefore leaves the archive UNREWRITTEN, so this dialect
//      has to answer both shapes rather than only the relative paths the ADR expected.
//
//   3. AN ABSOLUTE INTERNAL LINK COMES OUT BROKEN. The exporter substitutes the `/doc/…` portion in
//      place, leaving the host glued to the relative path it produced:
//        http://localhost:3400./Handbook/Onboarding.md
//      It is neither an external link nor a usable relative one. Reading it as external — the obvious
//      rule — hands the reader a link that goes nowhere, so it is recognised and resolved here.
//
// There is no manifest. Docmost names itself in a file; Outline's Markdown export carries nothing but
// the tree, so detection is structural and deliberately narrow (see `looksLikeOutlineExport`).

/** A percent-decoded path, or the original when it holds a stray `%` that is not an escape. */
export function safeDecodeOnce(s: string): string {
  try { return decodeURIComponent(s) } catch { return s }
}

/**
 * The key both sides of a comparison are reduced to.
 *
 * ⚠️ Decoded EXACTLY ONCE. That is fact 1 at the top of this file and it is the whole reason this
 * function exists rather than the caller decoding inline: a second pass turns `%2F` into `/` and
 * invents a path separator the archive does not have, so the pages whose titles contain a slash — the
 * ones most likely to be non-English — stop matching.
 */
export function outlineKey(path: string): string {
  return path.replace(/\.(md|markdown)$/i, '').toLowerCase()
}

/**
 * The same key, for a string that came out of a LINK rather than out of the archive.
 *
 * ⚠️ The two sides are encoded to different depths and this is the measurement, taken on the real
 * archive:
 * ```
 *   entry  Handbook/Handbook/<a Japanese title> %2F <rest>.md   the slash escaped once
 *   link   ./Handbook/%E9%81%8B…%20%252F%20…%E6%AC%A1.md   the whole path escaped again
 * ```
 * Decoding the link ONCE lands exactly on the entry as written, which is why the two functions exist
 * rather than one.
 *
 * ⚠️ Measured correction, kept because the obvious statement of this is wrong: decoding BOTH sides
 * once does not break the match. Both sides land on the same string and still agree. What it does
 * is turn an escaped slash into a real separator, so the key gains a segment boundary the archive
 * does not have — `resolveOutlineRelative` then walks `..` and `.` across it, and two pages whose
 * titles differ only either side of a slash reduce to the same key. The reason to keep the entry as
 * written is that it stays a faithful key, not that the fixture would fail without it.
 */
export function outlineLinkKey(target: string): string {
  return outlineKey(safeDecodeOnce(target))
}

/** Outline's own document URL, in both the shape it writes and the bare one it also accepts. */
const OUTLINE_DOC_URL = /(?:^|\/)doc\/(?:[0-9A-Za-z\-_~]*-)?([0-9A-Za-z]{10,15})(?:$|[/?#])/

/**
 * True when this archive looks like an Outline Markdown export.
 *
 * ⚠️ Deliberately narrow, and it will not fire on every Outline export. The directory shape — a
 * folder per collection, a `<title>.md` beside a `<title>/` for a document with children — is exactly
 * an Obsidian vault's shape, so the shape alone cannot be the fingerprint without claiming every
 * vault. What is distinctive is the LINK: a vault writes `[[wikilink]]`, and an Outline export writes
 * either a relative `.md` path the archive contains or a `/doc/` URL it did not manage to rewrite.
 *
 * An Outline export whose documents link to nothing therefore imports as a folder of Markdown, which
 * is the correct outcome rather than a miss: with no internal links there is nothing for this dialect
 * to resolve, and the two paths would produce identical pages.
 */
export function looksLikeOutlineExport(paths: readonly string[], bodyOf: (p: string) => string): boolean {
  const md = paths.filter((p) => /\.(md|markdown)$/i.test(p))
  if (md.length === 0) return false
  const keys = new Set(md.map((p) => outlineKey(p)))
  for (const p of md) {
    const body = bodyOf(p)
    if (/\[\[/.test(body)) return false // a vault: its own dialect owns this archive
    // ⚠️ Three capture groups: the leading `!`, the label, then the target. Destructuring one slot
    // short reads the LABEL as the target, which is silently false for every archive rather than
    // noisily wrong for one — measured, and it made this predicate answer no on a real export.
    for (const [, , , target] of body.matchAll(MD_LINK)) {
      if (!target) continue
      if (OUTLINE_DOC_URL.test(safeDecodeOnce(target))) return true
      if (/^(https?:|mailto:|#)/i.test(target)) continue
      if (!/\.(md|markdown)$/i.test(target.split(/[?#]/)[0] ?? '')) continue
      if (keys.has(resolveOutlineRelative(target, dirOf(p)))) return true
    }
  }
  return false
}

// ⚠️ NOTHING IS REPORTED AS DROPPED, and that is a measurement rather than an omission. The Markdown
// export carries no per-document metadata — no icon, no timestamps, no author, no manifest — so there
// is nothing here for a report to name. Inventing a degradation code would tell a reader that a loss
// had been counted page by page when no page carried anything to lose.
//
// NOT MEASURED, and therefore not claimed either way: attachments (this archive had none; wiring
// Outline's file storage was out of the probe's reach), the HTML, TextBundle and JSON formats, and
// an emoji in a document title. If any of those turn out to carry something, it belongs in a report.
const MD_LINK = /(!?)\[([^\]]*)\]\(([^)\s]+)\)/g

/** The directory a link in this file is written relative to. */
export function dirOf(path: string): string {
  const i = path.lastIndexOf('/')
  return i === -1 ? '' : path.slice(0, i)
}

/** Resolve a link target against the directory of the file it was written in, as a comparison key. */
export function resolveOutlineRelative(target: string, fromDir: string): string {
  const decoded = outlineLinkKey(target.split(/[?#]/)[0] ?? '')
  if (decoded.startsWith('/')) return decoded.replace(/^\/+/, '')
  // ⚠️ `fromDir` goes through the same reduction as the target. It arrives as an ARCHIVE path — mixed
  // case, possibly encoded — while the map is keyed on `outlineKey`, so joining the raw directory to
  // a reduced target produces a key that matches nothing and every link reads as dead.
  const base = fromDir ? outlineKey(fromDir) : ''
  const parts = (base ? `${base}/${decoded}` : decoded).split('/')
  const out: string[] = []
  for (const seg of parts) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') { out.pop(); continue }
    out.push(seg)
  }
  return out.join('/')
}

/**
 * ⚠️ Split the host off an internal link the exporter broke (fact 3).
 *
 * Returns the relative path when the target is one of these, and null otherwise. The test is not "does
 * it start with http" — a genuine external link does too — but "does the host run straight into a
 * relative path with no `/` between them", which is what the in-place substitution leaves behind and
 * what no correctly-formed URL looks like.
 */
export function splitBrokenAbsolute(target: string): string | null {
  const m = /^https?:\/\/[^/\s]+(\.{1,2}\/.*)$/i.exec(target)
  return m ? m[1]! : null
}

export interface OutlineLinkMaps {
  /** decoded archive key (see `outlineKey`) → `/p/<newId>` */
  hrefByPath: ReadonlyMap<string, string>
  /** Outline document id (the trailing part of `/doc/<slug>-<id>`) → `/p/<newId>` */
  hrefByDocId: ReadonlyMap<string, string>
}

/**
 * Rewrite the links Outline writes, against maps built once every page id is known.
 *
 * Unresolvable links are LEFT AS WRITTEN and counted, which is the rule every dialect here follows.
 * A `/doc/` URL whose document was not part of the export is NOT counted: it names a page the archive
 * never carried, which is the same case as Docmost's absolute host URLs.
 */
export function rewriteOutlineLinks(
  markdown: string,
  nodeDir: string,
  maps: OutlineLinkMaps,
): { markdown: string; deadLinks: number } {
  // ⚠️ `nodeDir` is the page's own key (its archive path without the extension), and a link is written
  // relative to the DIRECTORY the file sits in — one level up from that. Passing the node key straight
  // through would resolve every link one level too deep, which is invisible in a flat archive and
  // wrong in every nested one: exactly the shape this exporter always produces.
  const fromDir = dirOf(nodeDir)
  let deadLinks = 0
  const out = markdown.replace(MD_LINK, (whole, bang: string, label: string, target: string) => {
    if (bang) return whole // an embed — the attachment passes own it
    if (/^(mailto:|#|\/p\/|wks-attachment:)/i.test(target)) return whole

    // Fact 3 first: the host-glued form would otherwise be read as external and left broken.
    const unglued = splitBrokenAbsolute(target)
    const path = unglued ?? target

    const docId = OUTLINE_DOC_URL.exec(safeDecodeOnce(path))?.[1]
    if (docId) {
      const byId = maps.hrefByDocId.get(docId)
      return byId ? `[${label}](${byId})` : whole // a document outside the export: not a dead link
    }
    if (!unglued && /^https?:/i.test(target)) return whole

    const href = maps.hrefByPath.get(resolveOutlineRelative(path, fromDir))
    if (!href) { deadLinks++; return whole }
    return `[${label}](${href})`
  })
  return { markdown: out, deadLinks }
}

/**
 * The Outline document id a body's own links would use to name this page, or null.
 *
 * ⚠️ There is no id in the archive. Outline's Markdown export writes no manifest and no front matter,
 * so a document's id survives only where ANOTHER document links to it — and only when the exporter
 * failed to rewrite that link (fact 2). This reads the id back out of the links themselves, which is
 * why the map it feeds is built from every body rather than from the tree.
 */
export function outlineDocIdOf(target: string): string | null {
  return OUTLINE_DOC_URL.exec(safeDecodeOnce(target))?.[1] ?? null
}

/** Every `(target)` in a Markdown body, for the passes that need to look at links without editing them. */
export function outlineLinkTargets(markdown: string): string[] {
  return [...markdown.matchAll(MD_LINK)].map((m) => m[3] as string)
}
