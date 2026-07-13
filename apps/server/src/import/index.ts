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
import { Unzip, UnzipInflate, strFromU8 } from 'fflate'
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

  // Every `<dir>/index.md` is a page. (A plain Markdown folder can also carry loose `<name>.md`; v1 keys on
  // the export's index.md convention — a bare `.md` file is treated as its own single-page dir.)
  const pageDirs: string[] = []
  const bodyByDir = new Map<string, string>()
  for (const [name, bytes] of Object.entries(files)) {
    if (name === 'manifest.json') continue
    let dir: string | null = null
    if (name.endsWith('/index.md')) dir = name.slice(0, -'/index.md'.length)
    else if (name === 'index.md') dir = ''
    if (dir == null) continue
    pageDirs.push(dir)
    bodyByDir.set(dir, strFromU8(bytes))
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
  return { roots, hasManifest: manifest != null }
}

// ── Materializer ─────────────────────────────────────────────────────────────
export interface ImportReport {
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
function rewriteBody(markdown: string, attByRel: Map<string, string>, pageIdMap: Map<string, string>, report: ImportReport): string {
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
  args: { tenantId: string; spaceId: string; userId: string; plan: string; parentPageId?: string | null; publish?: boolean },
): Promise<ImportReport> {
  const { db, fga, storage, driver } = deps
  const report: ImportReport = {
    pagesCreated: 0, emptyPagesCreated: 0, attachmentsImported: 0, attachmentsSkipped: [],
    deadCrossLinks: 0, published: 0, lossyTitles: !ir.hasManifest,
  }
  const created: Created[] = []
  const pageIdMap = new Map<string, string>() // oldId → newId (cross-link remap)

  try {
    // Pass 1 — create every page (edit-gated) + re-upload its attachments; collect the id maps.
    async function createNode(node: ImportNode, parentId: string | null): Promise<void> {
      const page = await createPage(db, fga, driver, { tenantId: args.tenantId, spaceId: args.spaceId, userId: args.userId, title: node.title, parentId })
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
      for (const child of node.children) await createNode(child, page.id)
    }
    for (const root of ir.roots) await createNode(root, args.parentPageId ?? null)

    // Pass 2 — now every id is known: rewrite each body (images + cross-links) and set the draft; optional publish.
    for (const c of created) {
      const md = rewriteBody(c.node.markdown, c.attByRel, pageIdMap, report)
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

// Top-level entry: unzip (streaming, capped) → IR → materialize. The route calls this after decoding the
// uploaded base64 ZIP and gating the executor as a MEMBER (ADR-132 §4).
export async function importArchive(
  deps: { db: TenantDb; fga: OpenFgaClient; storage: StorageDriver; driver: SearchDriver },
  archive: Uint8Array,
  args: { tenantId: string; spaceId: string; userId: string; plan: string; parentPageId?: string | null; publish?: boolean },
): Promise<ImportReport> {
  const files = streamingUnzip(archive)
  const ir = buildIR(files)
  if (ir.roots.length === 0) throw new ImportInvalidError('archive has no importable pages')
  return materializeImport(deps, ir, args)
}
