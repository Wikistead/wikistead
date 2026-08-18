// Content import (#308 / ADR-132) — the reverse of the export (apps/server/src/export). Takes a Wikistead
// export ZIP (or a plain Markdown folder zipped the same way) and materializes it as a tree of DRAFT pages in a
// destination space. Two layers keep new source formats additive (ADR-132 §1): an ImportSource turns the
// archive into a format-neutral IntermediateRepresentation (a tree of nodes + attachments), and the
// Materializer turns the IR into created pages (id allocation, link rewrite, attachment re-upload, authz,
// draft/publish) — the materializer is shared by every future source (Notion/Confluence/Obsidian adapters only
// add a new ImportSource).
//
// Security (ADR-132 §3): the archive is UNTRUSTED. Unzip is STREAMING with mid-inflation size caps (a zip bomb
// aborts DURING inflation, before it can OOM). Entry names are OPAQUE tree labels only — never a write path
// (bodies land in the DB; attachments land at server-generated S3 keys). Bodies are stored verbatim as Markdown
// and only sanitized at RENDER time by the existing fort — import never evaluates content.
import { Unzip, UnzipInflate, strFromU8, strToU8 } from 'fflate'
import * as Y from 'yjs'
import type { OpenFgaClient } from '@openfga/sdk'
import { resolveEntitlements, decideAllowance } from '@wikistead/entitlements'
import { extractHeadingsFromMarkdown } from '@wikistead/macro-render'
import type { TenantDb } from '../db/index.js'
import type { StorageDriver } from '../storage/index.js'
import type { SearchDriver } from '../search/index.js'
import { makeS3Key } from '../storage/driver.js'
import { sniffInlineKind } from '../routes/attachments.js'
import { createPage, publishPage, deletePage } from '../routes/pages.js'
import { noteNameOf, rewriteWikilinks, detectVaultDegradations, canvasDegradations, walkNodes, vaultAttachments, convertVaultCallouts, isExcalidrawNote, convertExcalidrawNote } from './obsidian.js'
import { looksLikeNotionExport, splitNotionName, parseCsv, csvToMarkdownTable, databaseDegradation, rewriteNotionLinks } from './notion.js'
import { looksLikeConfluenceExport, confluenceHtmlToMarkdown } from './confluence.js'

// Zip-bomb caps (ADR-132 §3). The importer aborts the moment a running total is exceeded — it never buffers a
// whole malicious archive. These are generous enough for a real workspace export yet bound worst-case memory.
export const IMPORT_MAX_TOTAL_BYTES = 200 * 1024 * 1024 // total inflated across all entries
export const IMPORT_MAX_ENTRY_BYTES = 50 * 1024 * 1024 // any single inflated entry
export const IMPORT_MAX_ENTRIES = 5000

export class ImportTooLargeError extends Error {
  constructor(message = 'import archive exceeds a size limit') { super(message); this.name = 'ImportTooLargeError' }
}
export class ImportInvalidError extends Error {
  constructor(message = 'invalid import archive') { super(message); this.name = 'ImportInvalidError' }
}

// STREAMING unzip with mid-inflation abort (ADR-132 §3). fflate's UnzipInflate is synchronous, so the ondata
// callbacks fire during push; we accumulate per-entry and running-total inflated bytes and trip a cap the
// instant either is exceeded (terminating the offending stream), then throw after the synchronous push returns.
// Only STORED/DEFLATE entries are decoded (what our export writes); an unknown compression method throws.
export interface UnzipCaps { maxTotalBytes: number; maxEntryBytes: number; maxEntries: number }
const DEFAULT_CAPS: UnzipCaps = { maxTotalBytes: IMPORT_MAX_TOTAL_BYTES, maxEntryBytes: IMPORT_MAX_ENTRY_BYTES, maxEntries: IMPORT_MAX_ENTRIES }

export function streamingUnzip(archive: Uint8Array, caps: UnzipCaps = DEFAULT_CAPS): Record<string, Uint8Array> {
  const files: Record<string, Uint8Array> = {}
  let total = 0
  let count = 0
  let capErr: Error | null = null

  const uz = new Unzip((file) => {
    if (capErr) return
    if (++count > caps.maxEntries) { capErr = new ImportTooLargeError('too many archive entries'); return }
    const chunks: Uint8Array[] = []
    let entrySize = 0
    file.ondata = (err, chunk, final) => {
      if (capErr) return
      if (err) { capErr = err; return }
      entrySize += chunk.length
      total += chunk.length
      if (entrySize > caps.maxEntryBytes || total > caps.maxTotalBytes) {
        capErr = new ImportTooLargeError()
        try { file.terminate() } catch { /* stream already ended */ }
        return
      }
      chunks.push(chunk)
      if (final) {
        const out = new Uint8Array(entrySize)
        let o = 0
        for (const c of chunks) { out.set(c, o); o += c.length }
        files[file.name] = out
      }
    }
    // Only inflate the entries we can handle; file.start throws for an unregistered compression method.
    try { file.start() } catch (e) { capErr = e as Error }
  })
  uz.register(UnzipInflate)
  try { uz.push(archive, true) } catch (e) { if (!capErr) capErr = e as Error }
  if (capErr) throw capErr
  return files
}

// ── Intermediate representation (format-neutral) ─────────────────────────────
export interface ImportAttachment { relPath: string; name: string; bytes: Uint8Array; mime: string }
export interface ImportNode {
  dir: string
  title: string
  markdown: string
  published: boolean
  oldId: string | null // from manifest — used to remap /p/<oldId> cross-links
  attachments: ImportAttachment[]
  children: ImportNode[]
  // #712 / ADR-227 §2 — the three additions every third-party adapter shares.
  //
  // `sourceRef`: the key THIS source uses to refer to the node in its own links (Obsidian: the note
  // name; Notion: the 32-hex filename suffix). Never persisted as an id — cross-tenant id reuse stays
  // refused (ADR-132 §2) — it exists only to build the link map during one import.
  sourceRef?: string
  /** #712 §5: the 32-hex id a Notion export puts in every filename — the key its links point at. */
  notionHex?: string | null
  /** #712G: true when this node came from an Obsidian Excalidraw note (`*.excalidraw.md`). */
  excalidrawNote?: boolean
  // `frontmatter`: structured metadata an adapter carries over. Serialised as YAML at the top of the
  // body, which is where tags already live (ADR-145), so no second tag path appears.
  frontmatter?: Record<string, unknown>
  // #364 / ADR-157 §5: the archive-root `_home.md`. Imported as a regular page; the target space's
  // home pointer is set only when NONE exists (never a silent overwrite). Empty title resolves to
  // the target space's name at materialize time (the no-manifest foreign-ZIP case).
  isHome?: boolean
}
export interface ExportManifest {
  formatVersion: number
  pages: { oldId: string; dir: string; title: string; published: boolean }[]
}
export interface ImportIR {
  roots: ImportNode[]
  hasManifest: boolean // false → plain-folder best-effort (dir-name titles, no oldId cross-link remap)
}

const EXT_MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  svg: 'image/svg+xml', pdf: 'application/pdf', md: 'text/markdown', txt: 'text/plain',
}
function mimeFromName(name: string): string {
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase()
  return (ext && EXT_MIME[ext]) || 'application/octet-stream'
}
function baseName(path: string): string { return path.slice(path.lastIndexOf('/') + 1) }
function dirTitle(dir: string): string { return baseName(dir).replace(/-\d+$/, '') || 'Untitled' }

// Build the IR tree from the flat unzipped entries + (optional) manifest. The export writes one `<dir>/index.md`
// per page and co-locates attachments at `<dir>/images/<name>`; the manifest maps `dir → {oldId, title,
// published}` (v1-required for a lossless round-trip). The tree is reconstructed from dir NESTING: a page whose
// dir is the longest page-dir prefix of another page's dir is that page's parent (so a space-prefixed tenant
// export's pages simply become import roots — the space label is not a page and is skipped). Entry names are
// used ONLY as these opaque hierarchy labels; nothing is ever written to a path derived from them.
export function buildIR(files: Record<string, Uint8Array>): ImportIR {
  let manifest: ExportManifest | null = null
  if (files['manifest.json']) {
    try {
      const parsed = JSON.parse(strFromU8(files['manifest.json'])) as ExportManifest
      if (parsed && Array.isArray(parsed.pages)) manifest = parsed
    } catch { /* malformed manifest → best-effort folder import */ }
  }
  const byDir = new Map<string, { oldId: string; title: string; published: boolean }>()
  for (const p of manifest?.pages ?? []) if (typeof p.dir === 'string') byDir.set(p.dir, p)

  // Every `<dir>/index.md` is a page, and a bare `<name>.md` is its own single-page dir `<name>` (#501
  // the comment always promised this; a ZIP of loose notes is the most common "bring my markdown" shape).
  // Precedence and exclusions
  // - `<dir>/index.md` OUTRANKS a sibling bare `<dir>.md` (the export's convention is authoritative);
  // - a `.md` sitting in an attachment folder (`…/images/`, `_home_images/`) stays an attachment, never
  // becomes a page (it would otherwise be imported twice);
  // - the archive-root `_home.md` is the space home (handled below), not a bare page;
  // - bare pages get no `images/` co-location of their own (v1: attachments key on the dir convention).
  const pageDirs: string[] = []
  const bodyByDir = new Map<string, string>()
  const bareBodies = new Map<string, string>()
  for (const [name, bytes] of Object.entries(files)) {
    if (name === 'manifest.json') continue
    if (name.endsWith('/index.md')) {
      const dir = name.slice(0, -'/index.md'.length)
      pageDirs.push(dir)
      bodyByDir.set(dir, strFromU8(bytes))
    } else if (name === 'index.md') {
      pageDirs.push('')
      bodyByDir.set('', strFromU8(bytes))
    } else if (name.endsWith('.md') && name !== '_home.md' && !/(^|\/)(images|_home_images)\/[^/]+$/.test(name)) {
      bareBodies.set(name.slice(0, -'.md'.length), strFromU8(bytes))
    }
  }
  for (const [dir, body] of bareBodies) {
    if (bodyByDir.has(dir)) continue // index.md precedence
    pageDirs.push(dir)
    bodyByDir.set(dir, body)
  }
  const pageDirSet = new Set(pageDirs)

  // A node's own attachments = files directly under `<dir>/images/` (not a descendant page's images).
  function attachmentsFor(dir: string): ImportAttachment[] {
    const prefix = dir ? `${dir}/images/` : 'images/'
    const out: ImportAttachment[] = []
    for (const [name, bytes] of Object.entries(files)) {
      if (!name.startsWith(prefix)) continue
      const rest = name.slice(prefix.length)
      if (rest.includes('/') || rest === '') continue // only direct children of images/
      out.push({ relPath: `images/${rest}`, name: rest, bytes, mime: mimeFromName(rest) })
    }
    return out
  }

  const nodeByDir = new Map<string, ImportNode>()
  for (const dir of pageDirs) {
    const meta = byDir.get(dir)
    const markdown = bodyByDir.get(dir) ?? ''
    nodeByDir.set(dir, {
      dir,
      title: meta?.title ?? dirTitle(dir),
      markdown,
      published: meta ? meta.published : markdown.trim().length > 0,
      oldId: meta?.oldId ?? null,
      attachments: attachmentsFor(dir),
      children: [],
    })
  }

  // Longest page-dir strict prefix = parent; none → root.
  function parentDirOf(dir: string): string | null {
    let best: string | null = null
    for (const cand of pageDirSet) {
      if (cand === dir) continue
      if (dir.startsWith(`${cand}/`) && (best == null || cand.length > best.length)) best = cand
    }
    return best
  }
  const roots: ImportNode[] = []
  for (const dir of pageDirs) {
    const node = nodeByDir.get(dir)!
    const parent = parentDirOf(dir)
    if (parent != null && nodeByDir.has(parent)) nodeByDir.get(parent)!.children.push(node)
    else roots.push(node)
  }
  // #364 / ADR-157 §5: the archive-root `_home.md` (the exporter writes the home there instead of a
  // page directory; images under `_home_images/`). Always a ROOT node; the manifest's `_home` entry
  // carries its title/oldId when present, a foreign ZIP resolves the title at materialize time.
  if (files['_home.md']) {
    const meta = byDir.get('_home')
    const markdown = strFromU8(files['_home.md']!)
    const homeAtts: ImportAttachment[] = []
    for (const [name, bytes] of Object.entries(files)) {
      if (!name.startsWith('_home_images/')) continue
      const rest = name.slice('_home_images/'.length)
      if (rest.includes('/') || rest === '') continue
      homeAtts.push({ relPath: `_home_images/${rest}`, name: rest, bytes, mime: mimeFromName(rest) })
    }
    roots.unshift({
      dir: '_home',
      title: meta?.title ?? '',
      markdown,
      published: meta ? meta.published : markdown.trim().length > 0,
      oldId: meta?.oldId ?? null,
      attachments: homeAtts,
      children: [],
      isHome: true,
    })
  }
  return { roots, hasManifest: manifest != null }
}

// ── Materializer ─────────────────────────────────────────────────────────────
// #712 / ADR-227 §2: what an adapter could NOT represent, named rather than counted. The existing
// counters answer "how much"; a migration also has to answer "what did I lose", or the product that
// sells Open formats is the one lying at the door.
// #725②: this report IS the feature, and in a Japanese workspace it was the only English left
// on the screen. The headings and the page's prose translated; the words a reader uses to judge what
// they lost ("wikilink heading anchor dropped") did not, because the server composed them here as
// English sentences and the screen printed them through.
//
// So a degradation carries a CODE and its variables, and the SCREEN owns the wording. The other
// option — a lookup table in the client, keyed on the English sentence — fails the day the server
// adds a kind: an unknown sentence has no entry, so the gap shows up as ENGLISH rather than as a red
// test, which is exactly the failure that produced this ticket.
//
// `what` stays, in English, for two reasons: it is what the API has always handed anything reading a
// report programmatically, and it is the screen's fallback. The pin (`degradation-i18n-725`) walks
// this list against both locale bundles, so a new code with no wording is red before it can ship.
export const DEGRADATION_CODES = [
  'embedSizeDropped', 'noteEmbedBecameLink', 'blockRefDropped', 'headingAnchorDropped',
  'calloutTypeMapped', 'calloutExpanded', 'dataviewKeptAsSource', 'obsidianCommentKept',
  'inlineDataviewKept', 'rawHtmlKept', 'blockIdLeft', 'excalidrawCompressed',
  'excalidrawUnreadable', 'canvasNotImported', 'notionDatabaseFlattened',
  'confluenceStorageFormat', 'confluenceMacroNoEquivalent', 'mergedCellsFlattened',
  'emojiReplacedByName', 'linkOutsideExport', 'attachmentLinkMissing',
] as const
export type DegradationCode = typeof DEGRADATION_CODES[number]

export interface ImportDegradation {
  node: string // the node's title or dir — what the reader would recognise
  code: DegradationCode // what the screen renders, in the reader's own language
  what: string // the same shape in English: the API's own words, and the screen's fallback
  detail?: string // English detail, likewise a fallback — `params` is what the wording is built from
  /** the variables the wording interpolates: counts, link targets, file and macro names */
  params?: Record<string, string | number>
}

// #746 (user ruling, 2026-08-19): an import PUBLISHES unless the caller says otherwise. ADR-132 chose the
// opposite, and the way that showed on the running product was a successful import whose pages read as
// empty — the read surface and the export both show the published version, and nothing had been published.
// ADR-236 gave the report a sentence to explain it. A default that has to be explained is the wrong one.
//
// ONE definition, resolved here rather than at each entry point. Before this, the synchronous route and the
// job row each coerced the flag on their own (`=== true` in two places); with the default moving, two
// coercions is two chances for the sync path and the queued path to disagree about the same upload.
export const IMPORT_PUBLISHES_BY_DEFAULT = true
export const resolveImportPublish = (v: boolean | undefined): boolean => v ?? IMPORT_PUBLISHES_BY_DEFAULT

export interface ImportReport {
  degraded: ImportDegradation[]
  pagesCreated: number
  emptyPagesCreated: number // unpublished-source nodes created as empty drafts (#309/)
  attachmentsImported: number
  attachmentsSkipped: { name: string; reason: string }[]
  deadCrossLinks: number // /p/<oldId> whose target was outside the import (left as-is → the dead-link UI marks it)
  published: number
  lossyTitles: boolean // no manifest → titles came from dir names
}

const ATTACHMENT_REF = /!\[([^\]]*)\]\(([^)\s]+)\)/g
/** The same shape WITHOUT the leading `!` — a file link rather than an embed (#712①). */
const FILE_LINK = /\[([^\]]*)\]\(([^)\s]+)\)/g
/** Exports percent-encode spaces in asset paths; the name has to be compared decoded. */
function decodeAttUrl(u: string): string { try { return decodeURIComponent(u) } catch { return u } }
const INTERNAL_LINK = /\/p\/([A-Za-z0-9_-]+)/g

interface Created { node: ImportNode; newId: string; attByRel: Map<string, string> }

// Re-upload one attachment through the materializer's OWN upload gate (ADR-132 §3): the storage-quota check +
// the confirm-time content sniff — NOT a raw putObject (which would bypass both). Returns the new attachment id,
// or null when the storage quota refuses it (recorded in the report, never silently dropped).
async function importAttachment(
  db: TenantDb,
  storage: StorageDriver,
  args: { tenantId: string; plan: string; pageId: string; att: ImportAttachment },
): Promise<string | null> {
  const quota = resolveEntitlements(args.plan).maxStorageBytes
  if (isFinite(quota)) {
    const [{ used }] = await db.sql<[{ used: string }]>`
      SELECT COALESCE(SUM(size_bytes), 0)::text AS used FROM attachments WHERE tenant_id = ${args.tenantId} AND status = 'confirmed'`
    if (!decideAllowance(Number(used), quota).allowed) return null
  }
  const [{ id }] = await db.sql<[{ id: string }]>`SELECT gen_random_uuid()::text AS id`
  const s3Key = makeS3Key(args.tenantId, args.pageId, id, args.att.name)
  await storage.putObject(s3Key, args.att.bytes, args.att.mime)
  let inlineKind: string = 'none'
  try { inlineKind = sniffInlineKind(args.att.bytes) } catch { /* unreadable → none */ }
  await db.sql`
    INSERT INTO attachments (id, tenant_id, page_id, filename, content_type, s3_key, status, size_bytes, confirmed_at, inline_kind)
    VALUES (${id}, ${args.tenantId}, ${args.pageId}, ${args.att.name}, ${args.att.mime}, ${s3Key}, 'confirmed', ${args.att.bytes.length}, now(), ${inlineKind})`
  return id
}

// Set a created page's DRAFT body (the canonical Y.Text 'content') to the rewritten markdown. Import lands as a
// draft (ADR-019); nothing is published unless the caller opts into bulk-publish.
async function setDraftBody(db: TenantDb, pageId: string, markdown: string): Promise<void> {
  const doc = new Y.Doc()
  doc.getText('content').insert(0, markdown)
  await db.sql`UPDATE pages SET ydoc = ${Buffer.from(Y.encodeStateAsUpdate(doc))}, updated_at = now() WHERE id = ${pageId}`
}

// Rewrite a node's body for its new home: relative image links → wks-attachment:<newId>, and /p/<oldId>
// cross-links → /p/<newId> for pages that were part of the SAME import (a link to a page OUTSIDE the import is
// left as-is and counted — the #276 dead-link UI marks it; never a dangling rewrite to a bogus id).
function rewriteBody(
  markdown: string,
  attByRel: Map<string, string>,
  pageIdMap: Map<string, string>,
  report: ImportReport,
  // #712 / ADR-227 §3: the same two-pass rewrite now serves every source's own link shape. The
  // Wikistead ZIP speaks `/p/<oldId>`; a vault speaks `[[Note]]`. Both resolve against maps built
  // once all ids are known, and both leave an unresolvable link ALONE and count it.
  wiki?: { node: { title: string }; hrefByName: Map<string, string>; embedByName: Map<string, string> },
  // #712 / ADR-227 §5: Notion's own link shape, resolved through the same generic map idea — one
  // rewrite pass, one dead-link rule, three sources.
  notionHrefByHex?: ReadonlyMap<string, string>,
  /** Every node's attachments keyed by lower-cased FILE NAME — the cross-page fallback above. */
  attByName?: ReadonlyMap<string, string>,
): string {
  let md = markdown.replace(ATTACHMENT_REF, (m, alt: string, url: string) => {
    // ⚠️ The per-node map first, then EVERY node's attachments by FILE NAME. A Confluence export
    // keeps its images in one shared `attachments/` folder, and the collector hangs those on the
    // FIRST root — so only the first page could resolve `![](attachments/pic.png)` and every other
    // page kept the raw path while the report still counted the file as imported. Measured with a
    // two-page archive: put the referencing page second and its image broke. Real exports have many
    // pages, so in practice this was "the first page works".
    const newId = attByRel.get(url) ?? attByName?.get(decodeAttUrl(url).split('/').pop()?.toLowerCase() ?? '')
    return newId ? `![${alt}](wks-attachment:${newId})` : m
  })
  // #712① / c5496-B: a LINK to an attached file — `[paper](attachments/paper.pdf)` — is
  // the same file the image pass resolves, and the product already has notation for it
  // (`[name](wks-attachment:<id>)`, #273 / ADR-120). It could not be re-pointed at parse time because
  // the attachment id does not exist until materialisation; here it does. The parser therefore no
  // longer reports it as lost, and what stays unresolved is reported HERE, where "unresolved" is a
  // measured fact rather than a prediction.
  md = md.replace(FILE_LINK, (m, text: string, url: string, offset: number) => {
    if (offset > 0 && md[offset - 1] === '!') return m // an image: the pass above owns it
    if (/^(https?:|mailto:|#|\/p\/|wks-attachment:)/i.test(url)) return m
    const newId = attByRel.get(url) ?? attByName?.get(decodeAttUrl(url).split('/').pop()?.toLowerCase() ?? '')
    if (newId) return `[${text}](wks-attachment:${newId})`
    // Unresolved: the archive linked a file it did not carry. Said here rather than at parse time,
    // because only here is it known that the file really is absent.
    const file = decodeAttUrl(url).split('/').pop() ?? url
    // ⚠️ A source's own PAGE files are not attachments. `.html` was already excluded because a
    // Confluence export links its pages that way; a Notion export links its pages as `.md` and its
    // databases as `.csv`, and those fell through — so every cross-link in a Notion import produced
    // "link to an attached file the export does not carry" WHILE THE LINK WAS BEING RESOLVED
    // correctly two passes later (measured by #747's fidelity walk: body `/p/<id>`, report saying
    // the file is missing). A fidelity report that invents losses is worse than one that is quiet,
    // because it is the artefact the reader uses to decide what to go and fix.
    if (/\.[a-z0-9]{1,8}$/i.test(file) && !/\.(html?|md|markdown|csv)$/i.test(file)) {
      report.degraded.push({ node: wiki?.node.title ?? '', code: 'attachmentLinkMissing',
        what: 'link to an attached file the export does not carry', detail: file, params: { file } })
    }
    return m
  })
  md = md.replace(INTERNAL_LINK, (m, oldId: string) => {
    const newId = pageIdMap.get(oldId)
    if (newId) return `/p/${newId}`
    report.deadCrossLinks++
    return m
  })
  if (notionHrefByHex && notionHrefByHex.size) {
    const r = rewriteNotionLinks(md, notionHrefByHex)
    md = r.markdown
    report.deadCrossLinks += r.deadLinks
  }
  if (wiki) {
    const r = rewriteWikilinks(md, wiki.node, { hrefByName: wiki.hrefByName, embedByName: wiki.embedByName })
    md = r.markdown
    report.deadCrossLinks += r.deadLinks
    report.degraded.push(...r.degraded)
  }
  return md
}

// Materialize an IR into DRAFT pages under a destination space (optionally under a parent page). Every node goes
// through `createPage` (ADR-132 §4 invariant), which gates `edit` on the destination space and attaches the
// creator's `manage` grant — so import introduces NO bespoke authz and NO model.fga change. A NEW id is
// allocated per node (never the source id); cross-links + image refs are remapped after all ids are known.
// Failure model (ADR-132 §5): compensating rollback — on any error the pages created so far are deleted, so a
// partial import never lingers, then the error propagates.
export async function materializeImport(
  deps: { db: TenantDb; fga: OpenFgaClient; storage: StorageDriver; driver: SearchDriver },
  ir: ImportIR,
  args: { tenantId: string; spaceId: string; userId: string; plan: string; parentPageId?: string | null; publish?: boolean; onProgress?: (done: number) => void },
): Promise<ImportReport> {
  const { db, fga, storage, driver } = deps
  const report: ImportReport = {
    degraded: [], pagesCreated: 0, emptyPagesCreated: 0, attachmentsImported: 0, attachmentsSkipped: [],
    deadCrossLinks: 0, published: 0, lossyTitles: !ir.hasManifest,
  }
  const created: Created[] = []
  const pageIdMap = new Map<string, string>() // oldId → newId (cross-link remap)

  try {
    // Pass 1 — create every page (edit-gated) + re-upload its attachments; collect the id maps.
    async function createNode(node: ImportNode, parentId: string | null): Promise<void> {
      // #364 / ADR-157 §5: a home node with no manifest title is named after the TARGET space.
      let title = node.title
      if (node.isHome && !title) {
        const [sp] = await db.sql<[{ name: string }?]>`SELECT name FROM spaces WHERE id = ${args.spaceId}`
        title = sp?.name ?? 'Home'
      }
      const page = await createPage(db, fga, driver, { tenantId: args.tenantId, spaceId: args.spaceId, userId: args.userId, title, parentId })
      // #364: restore the home pointer only when the space has NONE (409-class conflict → the archive's
      // home stays a regular page, never a silent overwrite) and only for a space-level import.
      if (node.isHome && parentId == null) {
        await db.sql`UPDATE spaces SET home_page_id = ${page.id} WHERE id = ${args.spaceId} AND home_page_id IS NULL`
      }
      report.pagesCreated++
      if (!node.published || node.markdown.trim() === '') report.emptyPagesCreated++
      if (node.oldId) pageIdMap.set(node.oldId, page.id)
      const attByRel = new Map<string, string>()
      for (const att of node.attachments) {
        const newId = await importAttachment(db, storage, { tenantId: args.tenantId, plan: args.plan, pageId: page.id, att })
        if (newId) { attByRel.set(att.relPath, newId); report.attachmentsImported++ }
        else report.attachmentsSkipped.push({ name: att.name, reason: 'storage quota' })
      }
      created.push({ node, newId: page.id, attByRel })
      // §7 progress. Pass 1 is where the minutes go (a page + its attachments each), so counting it is
      // what makes a job's progress mean anything to the person watching it.
      args.onProgress?.(created.length)
      for (const child of node.children) await createNode(child, page.id)
    }
    for (const root of ir.roots) await createNode(root, args.parentPageId ?? null)

    // #712 / ADR-227 §4: the vault link maps, built once every id exists. Note names are matched
    // case-insensitively (the vault's own rule) and attachments by file name, because that is what a
    // `[[…]]` actually carries. Applied unconditionally: an archive with no wikilinks is unaffected,
    // and a plain Markdown folder that HAPPENS to use them gets them resolved, which is the behaviour
    // a reader expects from "import my notes".
    const hrefByName = new Map<string, string>()
    for (const c of created) {
      // A vault link is written either way — `[[Roadmap]]` or `[[Projects/Roadmap]]` — and Obsidian
      // resolves both. Measured on a real vault: keying only on the basename left every path-form
      // link unresolved. Both keys point at the same page; the basename is registered first so a
      // name collision keeps the shallower note, which is the vault's own precedence.
      const full = c.node.dir.toLowerCase()
      const base = (c.node.sourceRef ?? noteNameOf(c.node.dir)).toLowerCase()
      if (base && !hrefByName.has(base)) hrefByName.set(base, `/p/${c.newId}`)
      if (full && !hrefByName.has(full)) hrefByName.set(full, `/p/${c.newId}`)
    }
    // Same measurement, second defect: a vault keeps its attachments in ONE folder — `attachments/`
    // not co-located per page the way the Wikistead export does. So the embed map is built from
    // EVERY node's attachments, not just the embedding node's: `![[diagram.png]]` in one note refers
    // to a file the vault stores once, and a per-node map could never see it.
    const embedByName = new Map<string, string>()
    // …and the same index as bare ids, for the Markdown-image rewrite (see rewriteBody): a shared
    // attachment folder belongs to the ARCHIVE, not to whichever page happened to be created first.
    const attByName = new Map<string, string>()
    for (const c of created) {
      for (const [rel, attId] of c.attByRel) {
        const fileName = rel.slice(rel.lastIndexOf('/') + 1).toLowerCase()
        if (fileName && !embedByName.has(fileName)) embedByName.set(fileName, `![${fileName}](wks-attachment:${attId})`)
        if (fileName && !attByName.has(fileName)) attByName.set(fileName, attId)
      }
    }

    // Notion's links point at the 32-hex id in a filename, so the map is keyed on that.
    const notionHrefByHex = new Map<string, string>()
    for (const c of created) {
      const hex = c.node.notionHex
      if (hex && !notionHrefByHex.has(hex)) notionHrefByHex.set(hex, `/p/${c.newId}`)
    }

    // Pass 2 — now every id is known: rewrite each body (images + cross-links) and set the draft; optional publish.
    for (const c of created) {
      const nodeTitle = c.node.title || c.node.dir
      report.degraded.push(...detectVaultDegradations({ title: nodeTitle, markdown: c.node.markdown }))
      // #712H: a vault callout becomes THIS product's callout. Done before the link rewrite so
      // a `[[link]]` inside a callout body is resolved by the same pass everything else uses.
      const calls = convertVaultCallouts(c.node.markdown, { title: nodeTitle })
      c.node.markdown = calls.markdown
      report.degraded.push(...calls.degraded)
      // #712G: a `.excalidraw.md` note carries a drawing, and this product can render it.
      if (c.node.excalidrawNote) {
        const drawing = convertExcalidrawNote(c.node.markdown, { title: nodeTitle })
        c.node.markdown = drawing.markdown
        report.degraded.push(...drawing.degraded)
      }
      const md = rewriteBody(c.node.markdown, c.attByRel, pageIdMap, report, {
        node: { title: c.node.title || c.node.dir }, hrefByName, embedByName,
      }, notionHrefByHex, attByName)
      await setDraftBody(db, c.newId, md)
      if (args.publish && c.node.published && md.trim() !== '') {
        await publishPage(db, fga, driver, storage, { pageId: c.newId, subject: `user:${args.userId}`, createdBy: `user:${args.userId}` })
        report.published++
      }
    }
    return report
  } catch (e) {
    // Compensating rollback: delete everything created so a failed import leaves no partial tree. deletePage
    // cleans the DB row (+ attachment rows via cascade), FGA tuples, and the search index; the storage quota is
    // released with the attachment rows. (The uploaded S3 blobs themselves are left unreferenced — a harmless
    // storage leak reclaimed by GC, never a quota or authz problem; a job-based import would stream-clean them.)
    for (const c of created.reverse()) {
      await deletePage(db, fga, driver, { pageId: c.newId, userId: args.userId }).catch(() => {})
    }
    throw e
  }
}

/**
 * #729 / ADR-235: the dialects this importer speaks, as a TABLE the product can be asked about.
 *
 * Before this, the dialects were `if` branches inside prepareImport and nothing could enumerate
 * them — which is why three of them shipped without a word of documentation and no guard noticed
 * (#712). The docs-coverage walk reads this array, so a fourth dialect is in the ledger on the day
 * it is added rather than on the day somebody remembers.
 *
 * `detect` is the archive fingerprint, where the dialect has one. The two without it are not gaps:
 * `native` is identified by the manifest OUR OWN export writes, and `obsidian` is what a folder of
 * Markdown with no manifest and no other fingerprint is — a fallback cannot be a fingerprint. That
 * is stated here rather than left as an absent field for the next reader to interpret.
 *
 * #728 adds Docmost and Outline to this array. The union below is derived from it, so a dialect
 * that reaches `sourceKind` without a row here does not compile.
 */
export const IMPORT_ADAPTERS = [
  { id: 'native', detect: null },
  { id: 'obsidian', detect: null },
  { id: 'notion', detect: (names: string[]) => looksLikeNotionExport(names) },
  { id: 'confluence', detect: (names: string[]) => looksLikeConfluenceExport(names) },
] as const

export type ImportSourceKind = (typeof IMPORT_ADAPTERS)[number]['id']

/**
 * Ask ONE adapter whether this archive is its dialect.
 *
 * Deliberately not "find the first adapter that matches": the fingerprints are checked at different
 * points in prepareImport (Confluence converts before the tree is built, Notion reads names after),
 * and collapsing them into one ordered search would change which branch wins for an archive that
 * trips two fingerprints. Same question, same answer as before — just asked of the table.
 */
export function matchesAdapter(id: ImportSourceKind, fileNames: string[]): boolean {
  return IMPORT_ADAPTERS.find((a) => a.id === id)?.detect?.(fileNames) ?? false
}

// #712 / ADR-227 §7: the ARCHIVE-READING half, split out from importArchive so the node count can be known
// before anything is written. It is pure and cheap (unzip is already capped, the dialects only rewrite
// strings), which is what lets the route decide "synchronous or job" without a speculative write.
export interface PreparedImport {
  ir: ImportIR
  /** Which dialect this archive turned out to be. `native` is the export this product itself writes. */
  sourceKind: ImportSourceKind
  /** Degradations discovered while reading the archive — they belong to the report the materializer returns. */
  extraDegradations: ImportDegradation[]
  /** Pages this archive would create. The §7 threshold is measured against exactly this. */
  nodeCount: number
}

export function prepareImport(archive: Uint8Array): PreparedImport {
  let files = streamingUnzip(archive)
  let sourceKind: PreparedImport['sourceKind'] = 'native'
  const confluenceDegradations: ImportDegradation[] = []
  // #712 / ADR-227 §6 — Confluence. The shared builder speaks Markdown, so the conversion happens
  // FIRST and hands it an archive it already understands: each `.html` becomes a `.md` of the same
  // name. That keeps the tree logic, the attachment rules and the authz path identical for every
  // source, and guarantees no raw HTML ever reaches a page body (ADR-132 §3).
  if (matchesAdapter('confluence', Object.keys(files))) {
    sourceKind = 'confluence'
    const converted: Record<string, Uint8Array> = {}
    // The pages the archive actually carries, so a link OUT of the export is not turned into
    // wikilink notation nobody can resolve (see the `<a>` case in confluence.ts).
    const pageNames = new Set(
      Object.keys(files)
        .filter((p) => /\.html?$/i.test(p))
        .map((p) => p.replace(/\.html?$/i, '').split('/').pop()!.toLowerCase()),
    )
    for (const [path, bytes] of Object.entries(files)) {
      if (!/\.html?$/i.test(path)) { converted[path] = bytes; continue }
      const base = path.replace(/\.html?$/i, '')
      const leaf = base.slice(base.lastIndexOf('/') + 1)
      // The export's own index is navigation, not knowledge — importing it would create a page whose
      // entire body is a link list that the page tree already expresses.
      if (/^(index|main)$/i.test(leaf)) continue
      const { markdown, degraded } = confluenceHtmlToMarkdown(strFromU8(bytes), leaf, pageNames)
      converted[`${base}.md`] = strToU8(markdown)
      confluenceDegradations.push(...degraded)
    }
    files = converted
  }
  const ir = buildIR(files)
  if (ir.roots.length === 0) throw new ImportInvalidError('archive has no importable pages')
  const csvDegradations: ImportDegradation[] = []
  // #712 / ADR-227 §4: a vault's own note NAME is what `[[…]]` refers to, so it becomes each node's
  // sourceRef before materialisation (the link map is keyed on it). Doing it here rather than in
  // buildIR keeps the shared builder free of any one source's vocabulary.
  const nodes = walkNodes(ir.roots)
  for (const node of nodes) {
    node.sourceRef ??= noteNameOf(node.dir)
    // The `.excalidraw` half of the name is stripped by the tree builder, so the flag is set here
    // where the ARCHIVE path is still visible.
    if (isExcalidrawNote(`${node.dir}.md`) || isExcalidrawNote(`${node.dir}/index.md`)) node.excalidrawNote = true
  }

  // #712 / ADR-227 §5 — Notion. Detected from the export's own fingerprint (the 32-hex filename
  // suffix) rather than asked for: a user uploads "my export", not "my export, format N", and the
  // shapes are distinguishable without guessing. A Wikistead ZIP and a plain vault carry no such
  // suffix, so this branch cannot fire on them.
  if (matchesAdapter('notion', Object.keys(files))) {
    sourceKind = 'notion'
    for (const node of nodes) {
      const { title, hex } = splitNotionName(noteNameOf(node.dir))
      node.notionHex = hex
      // The id is noise in a title and load-bearing in a link: strip it from what the reader sees,
      // keep it as the link key. A node whose title came from a manifest is left alone.
      if (hex && title) node.title = title
    }
    // A database exports as `<name> <hex>.csv` beside a directory of row pages. It becomes ONE page
    // carrying a GFM table, with the rows as children (north star 2: this product does not grow a
    // database object). Reported per database — the views, filters and sorts genuinely do not survive.
    // ⚠️ Notion writes a database TWICE: `X <hex>.csv` is the current view and `X <hex>_all.csv` is
    // every row. Importing both made the same database appear as two pages, each reporting the same
    // degrade. The `_all` file is the superset, so it is the one that survives — taking the view
    // instead would silently drop whatever its filter hid, which is the thing this feature promises
    // not to do.
    const csvPaths = Object.keys(files).filter((p) => /\.csv$/i.test(p))
    const supersededByAll = new Set(
      csvPaths.filter((p) => csvPaths.includes(p.replace(/\.csv$/i, '_all.csv'))),
    )
    for (const [path, bytes] of Object.entries(files)) {
      if (!/\.csv$/i.test(path)) continue
      if (supersededByAll.has(path)) continue
      const base = path.replace(/(_all)?\.csv$/i, '')
      const rows = parseCsv(strFromU8(bytes))
      const { title, hex } = splitNotionName(base.slice(base.lastIndexOf('/') + 1))
      const owner = nodes.find((n) => n.dir === base)
      const table = csvToMarkdownTable(rows)
      if (owner) {
        // The directory already became a page (its own `index.md`): append the table to it.
        owner.markdown = owner.markdown.trim() ? `${owner.markdown.trimEnd()}\n\n${table}\n` : `${table}\n`
      } else {
        ir.roots.push({
          dir: base, title: title || base, markdown: `${table}\n`, published: true,
          oldId: null, attachments: [], children: [], sourceRef: base, notionHex: hex,
        })
      }
      csvDegradations.push(databaseDegradation(title || base, Math.max(0, rows.length - 1)))
    }
  }
  // A vault's shared attachment folder (see vaultAttachments): whatever the tree did not already
  // claim becomes an attachment, so `![[file]]` has something to resolve to. Anything already picked
  // up by the `<dir>/images/` convention is skipped, so a Wikistead export imports exactly as before.
  const claimed = new Set<string>()
  for (const node of nodes) {
    for (const att of node.attachments) {
      claimed.add(att.relPath)
      claimed.add(node.dir ? `${node.dir}/${att.relPath}` : att.relPath)
    }
    if (node.dir) claimed.add(`${node.dir}/index.md`), claimed.add(`${node.dir}.md`)
  }
  const shared = vaultAttachments(files, { claimed, mimeOf: mimeFromName })
  attachSharedFiles(nodes, ir.roots[0], shared)
  // An archive with no manifest is not this product's export: it is a folder of Markdown, which is
  // what a vault is too. Either way its file names are its titles rather than a lossy guess.
  if (sourceKind === 'native' && !ir.hasManifest) sourceKind = 'obsidian'
  return {
    ir,
    sourceKind,
    // Canvas files never became pages — reported rather than silently absent, which is the difference
    // between "we could not represent this" and "your vault came in fine".
    extraDegradations: [...csvDegradations, ...confluenceDegradations, ...canvasDegradations(Object.keys(files))],
    // Counted AFTER the Notion branch, which can add a database root of its own.
    nodeCount: walkNodes(ir.roots).length,
  }
}

/**
 * Hang each shared file on the page that REFERENCES it.
 *
 * #712③: they all went to the first root. The bodies were rewritten correctly (fixed the
 * lookup so any page could resolve any shared file), so this was invisible in the text — and it is
 * exactly the half that bites later: an attachment belongs to a page, and DELETING that page takes its
 * attachments with it. On a Confluence export the first page is whatever sorted first, so somebody
 * tidying up an index page would silently take every image in the space with it.
 *
 * Matched on the body rather than on a manifest, because none of the three dialects has one for this:
 * a vault writes `![[diagram.png]]`, Confluence writes `attachments/pic.png`, and both are just text by
 * the time we get here. First match wins; a file two pages share can only live on one of them, and the
 * lookup means the other page still renders it.
 *
 * Unreferenced files still land on the first root — that is where they were before, and dropping them
 * would be the silent loss this importer exists not to do. They are the `.obsidian`-shaped case minus
 * the config directories, which `vaultAttachments` now excludes outright.
 */
function attachSharedFiles(
  nodes: readonly ImportNode[],
  fallback: ImportNode | undefined,
  shared: readonly ImportAttachment[],
): void {
  if (!shared.length) return
  // One lowercase copy per node, not one per (node, file) pair: a vault with a hundred images and a
  // thousand notes would otherwise re-lowercase every body a hundred times.
  const bodies = nodes.map((n) => ({ node: n, text: n.markdown.toLowerCase() }))
  for (const att of shared) {
    const rel = att.relPath.toLowerCase()
    const name = att.name.toLowerCase()
    // The path first: it is the more specific claim, and two folders can hold `image.png`.
    const owner = bodies.find((b) => b.text.includes(rel))?.node
      ?? bodies.find((b) => b.text.includes(name))?.node
      ?? fallback
    owner?.attachments.push(att)
  }
}

// The WRITING half. Separate from prepareImport so the background job (§7) runs exactly the same
// materialization the synchronous route does — one code path, two callers, no second implementation of
// "what an import does" that could drift out of agreement with the tested one.
export async function runPreparedImport(
  deps: { db: TenantDb; fga: OpenFgaClient; storage: StorageDriver; driver: SearchDriver },
  prepared: PreparedImport,
  args: { tenantId: string; spaceId: string; userId: string; plan: string; parentPageId?: string | null; publish?: boolean; onProgress?: (done: number) => void },
): Promise<ImportReport> {
  const report = await materializeImport(deps, prepared.ir, args)
  report.degraded.push(...prepared.extraDegradations)
  // ⚠️ `lossyTitles` means "this product's own export arrived without its manifest, so the titles are
  // guesses from directory names". A THIRD-PARTY export has no manifest by definition and its file
  // names ARE its titles — flagging those is a warning that is true of every Notion, Confluence and
  // Obsidian import forever, which is a warning nobody can act on and everybody learns to ignore.
  if (prepared.sourceKind !== 'native') report.lossyTitles = false
  return report
}

// Top-level entry: unzip (streaming, capped) → IR → materialize. The route calls this after decoding the
// uploaded base64 ZIP and gating the executor as a MEMBER (ADR-132 §4).
export async function importArchive(
  deps: { db: TenantDb; fga: OpenFgaClient; storage: StorageDriver; driver: SearchDriver },
  archive: Uint8Array,
  args: { tenantId: string; spaceId: string; userId: string; plan: string; parentPageId?: string | null; publish?: boolean },
): Promise<ImportReport> {
  return runPreparedImport(deps, prepareImport(archive), args)
}
