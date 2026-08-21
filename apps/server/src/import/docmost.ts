// #728 / ADR-242 §3 — the Docmost dialect.
//
// Measured against archives Docmost 0.95.0 actually produced (a page export, a space export, and a
// space export carrying an attachment), not against its source code. Three of the facts ADR-242 read
// out of `export.service.ts` are the wrong way round in a real archive, and each one is the kind that
// makes an adapter work in English and fail in Japanese:
//
//   1. THE ZIP ENTRY NAMES ARE RAW BYTES. The ADR expected `encodeURIComponent`, and the encoding is
//      real — but it is applied to the LINKS and to the MANIFEST KEYS, not to the entry names:
//        entry     Handbook/<a title in Japanese>.md      (raw bytes)
//        link      (Handbook/%E9%81%8B%E7%94%A8%E6%89%8B%E9%A0%86%20%20%E6%97%A5%E6%AC%A1.md)
//      So both sides get decoded before they are compared, and neither side is assumed to be encoded.
//
//   2. THE LINKS AND THE MANIFEST DO NOT AGREE ON HOW TO SPELL THE SAME PAGE. A duplicate title
//      becomes `Title (1)`, and the parentheses are escaped in the link and left raw in the manifest
//      key (`Runbook%20%281%29.md` vs `Runbook%20(1).md`). Since duplicate titles are the ONLY way
//      those parentheses appear, matching the two as written would fail on exactly the pages that
//      need the manifest most.
//
//   3. A TITLE IS NOT ITS FILE NAME. The sanitiser DELETES `/` and leaves the spaces that were on
//      either side of it, so a title of the form `A / B` is stored as `A  B.md` — two spaces, no
//      slash. The real title survives as the `# ` heading Docmost writes at the top of every file,
//      which is where this reads it from.
//
// What the manifest does carry — `slugId` — is what makes a link written as a full URL resolvable, so
// the two link shapes this dialect answers are the relative path and `…/s/<space>/p/<slugId>`.
import type { ImportDegradation } from './index.js'

export const DOCMOST_MANIFEST = 'docmost-metadata.json'

/** One page as the manifest describes it. Keyed by the DECODED archive path (see `parseDocmostManifest`). */
export interface DocmostPageMeta {
  pageId: string
  slugId: string
  icon: string | null
  parentPath: string | null
}

/**
 * True when this archive is a Docmost export.
 *
 * The manifest's NAME is the fingerprint. Its `source: "docmost"` field is checked when the file is
 * parsed rather than here, because detection runs on entry names alone (the adapter table's contract)
 * and an archive that carries the file under this name is the dialect whether or not it parses.
 */
export function looksLikeDocmostExport(paths: readonly string[]): boolean {
  return paths.includes(DOCMOST_MANIFEST)
}

/** A percent-decoded path, or the original when it holds a stray `%` that is not an escape. */
export function safeDecodePath(s: string): string {
  try { return decodeURIComponent(s) } catch { return s }
}

/**
 * The key both sides of a comparison are reduced to: decoded, extension removed, lower-cased.
 *
 * This is the answer to fact 2 — the manifest and the links spell the same page differently, and the
 * only spelling both agree on is the decoded one.
 */
export function docmostKey(path: string): string {
  return safeDecodePath(path).replace(/\.(md|markdown)$/i, '').replace(/^\/+/, '').toLowerCase()
}

export interface DocmostManifest {
  version: string | null
  pages: Map<string, DocmostPageMeta>
}

/** Read the manifest, keyed by decoded path. A file that is not Docmost's own returns no pages. */
export function parseDocmostManifest(text: string): DocmostManifest {
  const empty: DocmostManifest = { version: null, pages: new Map() }
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { return empty }
  if (!parsed || typeof parsed !== 'object') return empty
  const obj = parsed as { source?: unknown; version?: unknown; pages?: unknown }
  if (obj.source !== 'docmost') return empty
  const pages = new Map<string, DocmostPageMeta>()
  if (obj.pages && typeof obj.pages === 'object') {
    for (const [path, raw] of Object.entries(obj.pages as Record<string, unknown>)) {
      if (!raw || typeof raw !== 'object') continue
      const p = raw as Record<string, unknown>
      pages.set(docmostKey(path), {
        pageId: typeof p.pageId === 'string' ? p.pageId : '',
        slugId: typeof p.slugId === 'string' ? p.slugId : '',
        icon: typeof p.icon === 'string' ? p.icon : null,
        parentPath: typeof p.parentPath === 'string' ? p.parentPath : null,
      })
    }
  }
  return { version: typeof obj.version === 'string' ? obj.version : null, pages }
}

/**
 * Collapse the empty path segment Docmost writes into attachment entries.
 *
 * A page that owns an attachment gets it at `<page folder>` + `<the /files/… path the database
 * holds>`, concatenated as-is, so the entry name is `Handbook//files/<id>/<name>` — two slashes with
 * nothing between them. Unzipping to disk hides this (the operating system folds it), which is why it
 * has to be handled here: the importer never touches a disk, it matches entry names as STRINGS, and
 * `Handbook/files/…` is not the name of anything in that archive.
 */
export function collapseEmptySegments(files: Record<string, Uint8Array>): { files: Record<string, Uint8Array>; collapsed: number } {
  const out: Record<string, Uint8Array> = {}
  let collapsed = 0
  for (const [name, bytes] of Object.entries(files)) {
    const fixed = name.replace(/\/{2,}/g, '/')
    if (fixed !== name) collapsed++
    // First writer wins: a real duplicate would mean the archive held both spellings, and taking the
    // later one would silently replace a file the tree has already been built to expect.
    if (!(fixed in out)) out[fixed] = bytes
  }
  return { files: out, collapsed }
}

/**
 * Take the title Docmost wrote as the body's first heading, and hand back the body without it.
 *
 * The heading is the ONLY place the untouched title survives (fact 3), and leaving it in place would
 * print the title twice on a product that carries the title beside the body. Only a heading in the
 * first position is taken: a file whose first line is prose keeps everything it has.
 */
export function splitDocmostTitle(markdown: string): { title: string | null; body: string } {
  const m = /^﻿?#[ \t]+([^\n]+?)[ \t]*(?:\n|$)/.exec(markdown)
  if (!m) return { title: null, body: markdown }
  const title = m[1]!.trim()
  if (!title) return { title: null, body: markdown }
  return { title, body: markdown.slice(m[0].length).replace(/^\n+/, '') }
}

// Same shape as the other dialects' rewriters: the leading `!` is captured so an EMBED is left to the
// attachment passes (the mistake #712 made in the Notion rewriter, where a page's own id was found
// inside an image path and the picture became a link to its own page).
const MD_LINK = /(!?)\[([^\]]*)\]\(([^)\s]+)\)/g
/** Docmost's own page URL, as it appears when the link's target was not part of the export. */
const DOCMOST_PAGE_URL = /(?:^|\/)s\/[^/]+\/p\/([0-9A-Za-z_-]+)$/

export interface DocmostLinkMaps {
  /** decoded archive key (see `docmostKey`) → `/p/<newId>` */
  hrefByPath: ReadonlyMap<string, string>
  /** manifest `slugId` → `/p/<newId>`, for the links written as a full URL */
  hrefBySlug: ReadonlyMap<string, string>
}

/**
 * Rewrite the links Docmost writes, against maps built once every page id is known.
 *
 * Unresolvable links are LEFT AS WRITTEN and counted — the rule every other source here follows. A
 * link out of the export (Docmost turns those into absolute URLs at its own host) is not a dead link
 * and is not counted: it points at a page that was never in the archive.
 */
export function rewriteDocmostLinks(
  markdown: string,
  fromDir: string,
  maps: DocmostLinkMaps,
): { markdown: string; deadLinks: number } {
  let deadLinks = 0
  const out = markdown.replace(MD_LINK, (whole, bang: string, label: string, target: string) => {
    if (bang) return whole // an embed — the attachment passes own it
    if (/^(mailto:|#|\/p\/|wks-attachment:)/i.test(target)) return whole
    const [pathPart = ''] = target.split(/[?#]/)
    const slug = DOCMOST_PAGE_URL.exec(safeDecodePath(pathPart))?.[1]
    if (slug) {
      const bySlug = maps.hrefBySlug.get(slug)
      return bySlug ? `[${label}](${bySlug})` : whole // a page outside the export: not a dead link
    }
    if (/^https?:/i.test(target)) return whole
    const href = maps.hrefByPath.get(resolveRelative(pathPart, fromDir))
    if (!href) { deadLinks++; return whole }
    return `[${label}](${href})`
  })
  return { markdown: out, deadLinks }
}

/**
 * Point every attachment reference at the path the ARCHIVE holds it under.
 *
 * Docmost writes the reference relative to the page's own folder (`files/<id>/<name>`) while the entry
 * is `<folder>/files/<id>/<name>`, so the two never matched as strings and the importer fell back to
 * matching by FILE NAME. Measured on a real export carrying the same attachment file name on two
 * pages under one name: both ended up showing the first file, and the report said two came across —
 * a picture silently replaced by another picture is the one loss a reader cannot see in the report.
 *
 * Rewritten DECODED, because the entry names are raw bytes while a Markdown-written reference is
 * percent-encoded (fact 1 at the top of this file).
 */
export function absolutizeAttachmentRefs(markdown: string, nodeDir: string): string {
  const folder = nodeDir.includes('/') ? nodeDir.slice(0, nodeDir.lastIndexOf('/')) : ''
  return markdown.replace(MD_LINK, (whole, bang: string, label: string, target: string) => {
    if (/^([a-z][a-z0-9+.-]*:|\/|#)/i.test(target)) return whole
    const decoded = safeDecodePath(target)
    if (!/^files\//.test(decoded)) return whole
    return `${bang}[${label}](${folder ? `${folder}/${decoded}` : decoded})`
  })
}

/** Resolve a link target against the directory of the file it was written in, as a comparison key. */
export function resolveRelative(target: string, fromDir: string): string {
  const decoded = docmostKey(target)
  if (target.startsWith('/')) return decoded
  const base = fromDir.includes('/') ? fromDir.slice(0, fromDir.lastIndexOf('/')).split('/') : []
  const stack: string[] = []
  for (const part of [...base, ...decoded.split('/')]) {
    if (!part || part === '.') continue
    if (part === '..') { stack.pop(); continue }
    stack.push(part)
  }
  return stack.join('/').toLowerCase()
}

/**
 * The one thing this dialect cannot carry across: the icon a page had.
 *
 * Reported per page rather than counted, because a workspace that uses icons uses them as its
 * navigation, and "your pages came in fine" over a tree that lost all of them is the report ADR-227
 * exists to prevent.
 */
export function iconDegradation(node: string, icon: string): ImportDegradation {
  return {
    node,
    code: 'docmostIconDropped',
    what: 'page icon not imported',
    detail: icon,
    params: { icon },
  }
}
