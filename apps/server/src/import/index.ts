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
import { noteNameOf, rewriteWikilinks, detectVaultDegradations, canvasDegradations, walkNodes, vaultAttachments } from './obsidian.js'
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
// callbacks fire during push(); we accumulate per-entry and running-total inflated bytes and trip a cap the
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
    // Only inflate the entries we can handle; file.start() throws for an unregistered compression method.
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

  // Every `<dir>/index.md` is a page, and a bare `<name>.md` is its own single-page dir `<name>` (#501 —
  // the comment always promised this; a ZIP of loose notes is the most common "bring my markdown" shape).
  // Precedence and exclusions:
  //  - `<dir>/index.md` OUTRANKS a sibling bare `<dir>.md` (the export's convention is authoritative);
  //  - a `.md` sitting in an attachment folder (`…/images/`, `_home_images/`) stays an attachment, never
  //    becomes a page (it would otherwise be imported twice);
  //  - the archive-root `_home.md` is the space home (handled below), not a bare page;
  //  - bare pages get no `images/` co-location of their own (v1: attachments key on the dir convention).
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
export interface ImportDegradation {
  node: string // the node's title or dir — what the reader would recognise
  what: string // the shape that did not survive, e.g. 'wikilink heading anchor'
  detail?: string
}

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
): string {
  let md = markdown.replace(ATTACHMENT_REF, (m, alt: string, url: string) => {
    const newId = attByRel.get(url)
    return newId ? `![${alt}](wks-attachment:${newId})` : m
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
    // Same measurement, second defect: a vault keeps its attachments in ONE folder — `attachments/` —
    // not co-located per page the way the Wikistead export does. So the embed map is built from
    // EVERY node's attachments, not just the embedding node's: `![[diagram.png]]` in one note refers
    // to a file the vault stores once, and a per-node map could never see it.
    const embedByName = new Map<string, string>()
    for (const c of created) {
      for (const [rel, attId] of c.attByRel) {
        const fileName = rel.slice(rel.lastIndexOf('/') + 1).toLowerCase()
        if (fileName && !embedByName.has(fileName)) embedByName.set(fileName, `![${fileName}](wks-attachment:${attId})`)
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
      report.degraded.push(...detectVaultDegradations({ title: c.node.title || c.node.dir, markdown: c.node.markdown }))
      const md = rewriteBody(c.node.markdown, c.attByRel, pageIdMap, report, {
        node: { title: c.node.title || c.node.dir }, hrefByName, embedByName,
      }, notionHrefByHex)
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

// #712 / ADR-227 §7: the ARCHIVE-READING half, split out from importArchive so the node count can be known
// before anything is written. It is pure and cheap (unzip is already capped, the dialects only rewrite
// strings), which is what lets the route decide "synchronous or job" without a speculative write.
export interface PreparedImport {
  ir: ImportIR
  /** Degradations discovered while reading the archive — they belong to the report the materializer returns. */
  extraDegradations: ImportDegradation[]
  /** Pages this archive would create. The §7 threshold is measured against exactly this. */
  nodeCount: number
}

export function prepareImport(archive: Uint8Array): PreparedImport {
  let files = streamingUnzip(archive)
  const confluenceDegradations: ImportDegradation[] = []
  // #712 / ADR-227 §6 — Confluence. The shared builder speaks Markdown, so the conversion happens
  // FIRST and hands it an archive it already understands: each `.html` becomes a `.md` of the same
  // name. That keeps the tree logic, the attachment rules and the authz path identical for every
  // source, and guarantees no raw HTML ever reaches a page body (ADR-132 §3).
  if (looksLikeConfluenceExport(Object.keys(files))) {
    const converted: Record<string, Uint8Array> = {}
    for (const [path, bytes] of Object.entries(files)) {
      if (!/\.html?$/i.test(path)) { converted[path] = bytes; continue }
      const base = path.replace(/\.html?$/i, '')
      const leaf = base.slice(base.lastIndexOf('/') + 1)
      // The export's own index is navigation, not knowledge — importing it would create a page whose
      // entire body is a link list that the page tree already expresses.
      if (/^(index|main)$/i.test(leaf)) continue
      const { markdown, degraded } = confluenceHtmlToMarkdown(strFromU8(bytes), leaf)
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
  for (const node of nodes) node.sourceRef ??= noteNameOf(node.dir)

  // #712 / ADR-227 §5 — Notion. Detected from the export's own fingerprint (the 32-hex filename
  // suffix) rather than asked for: a user uploads "my export", not "my export, format N", and the
  // shapes are distinguishable without guessing. A Wikistead ZIP and a plain vault carry no such
  // suffix, so this branch cannot fire on them.
  if (looksLikeNotionExport(Object.keys(files))) {
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
    for (const [path, bytes] of Object.entries(files)) {
      if (!/\.csv$/i.test(path)) continue
      const base = path.replace(/\.csv$/i, '')
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
  if (shared.length && ir.roots[0]) ir.roots[0].attachments.push(...shared)
  return {
    ir,
    // Canvas files never became pages — reported rather than silently absent, which is the difference
    // between "we could not represent this" and "your vault came in fine".
    extraDegradations: [...csvDegradations, ...confluenceDegradations, ...canvasDegradations(Object.keys(files))],
    // Counted AFTER the Notion branch, which can add a database root of its own.
    nodeCount: walkNodes(ir.roots).length,
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
