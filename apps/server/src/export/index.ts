// Export (P5). A page + its descendant subtree, as Markdown. Export reflects the
// PUBLISHED version (pages.published_md), never the live draft — so an in-progress
// edit is not exported until published. Images referenced as
// ![alt](wks-attachment:<id>) are BUNDLED (bytes co-located beside the page) with
// the link rewritten to a relative path — never a presigned URL (those expire and
// would leave a bearer token in the distributed file) and never the bare id (won't
// open elsewhere).
//
// Authorization: the root must be viewable (else null → 404). The subtree is
// view-FILTERED — pages the user can't view are simply omitted (never revealed),
// the same no-leak rule as the tree/search. Images are authorized per attachment:
// storage.getObject is an auth-bypassing raw read, so the CALLER re-checks `view`
// on each attachment's page before reading — a page that merely *references*
// another page's private attachment id never gets those bytes.
import { zipSync, strToU8 } from 'fflate'
import type { OpenFgaClient } from '@openfga/sdk'
import { check } from '@wikistead/authz'
import type { TenantDb } from '../db/index.js'
import type { StorageDriver } from '../storage/index.js'

const ATTACHMENT_REF = /!\[([^\]]*)\]\(wks-attachment:([^)\s]+)\)/g

// Sanitize user content into a safe ZIP path segment — no path traversal or
// separators (zip-slip defense: the archive is unpacked on someone else's machine).
export function safeSegment(s: string, fallback: string): string {
  const cleaned = (s || '')
    .replace(/[/\\]/g, '-') // path separators
    .replace(/\.{2,}/g, '.') // collapse runs of dots (.., ...)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f<>:"|?*]/g, '') // control chars + reserved (keeps spaces/letters/digits/unicode)
    .replace(/^[.\s]+|[.\s]+$/g, '') // leading/trailing dots & spaces
    .slice(0, 80)
  return cleaned || fallback
}

// Image entry name = <id>.<ext> ONLY — the user-supplied filename never enters the
// path, so "../../evil" can't escape. ext is derived + sanitized for the label.
export function imageEntryName(id: string, filename: string, contentType: string): string {
  const fromName = /\.([A-Za-z0-9]{1,8})$/.exec(filename || '')?.[1]
  const fromType = /\/([a-z0-9.+-]+)/.exec(contentType || '')?.[1]
  const ext = (fromName || fromType || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8) || 'bin'
  return `${id}.${ext}`
}

interface PageRow { id: string; title: string | null; published_md: string | null }

// Collect the view-authorized subtree rooted at rootId, each with its zip dir.
async function collectTree(
  db: TenantDb,
  fga: OpenFgaClient,
  userId: string,
  rootId: string,
): Promise<{ dir: string; id: string; title: string; body: string }[] | null> {
  if (!(await check(fga, `user:${userId}`, 'view', { type: 'page', id: rootId }))) return null
  const out: { dir: string; id: string; title: string; body: string }[] = []
  const used = new Set<string>()

  async function walk(pageId: string, prefix: string): Promise<void> {
    const [row] = await db.sql<PageRow[]>`SELECT id, title, published_md FROM pages WHERE id = ${pageId}`
    if (!row) return
    const base = safeSegment(row.title ?? '', row.id)
    let dir = prefix ? `${prefix}/${base}` : base
    for (let n = 2; used.has(dir); n++) dir = `${prefix ? `${prefix}/` : ''}${base}-${n}` // sibling collisions
    used.add(dir)
    out.push({ dir, id: row.id, title: row.title ?? '', body: row.published_md ?? '' })
    const kids = await db.sql<{ id: string }[]>`
      SELECT id FROM pages WHERE parent_id = ${pageId} ORDER BY position, created_at`
    for (const k of kids) {
      if (await check(fga, `user:${userId}`, 'view', { type: 'page', id: k.id })) await walk(k.id, dir)
    }
  }
  await walk(rootId, '')
  return out
}

export interface ExportResult { filename: string; contentType: string; body: Uint8Array }

export async function buildExport(
  db: TenantDb,
  fga: OpenFgaClient,
  storage: StorageDriver,
  args: { userId: string; rootId: string },
): Promise<ExportResult | null> {
  const tree = await collectTree(db, fga, args.userId, args.rootId)
  if (!tree) return null // root not viewable → caller returns 404

  const files: Record<string, Uint8Array> = {}
  for (const page of tree) {
    // Resolve referenced attachment ids → authorized image bytes, bundled beside
    // the page (so the markdown link is a same-dir relative path, no depth math).
    const refIds = [...page.body.matchAll(ATTACHMENT_REF)].map((m) => m[2]!)
    const entryById = new Map<string, string>() // id → relative name (images/<id>.<ext>)
    if (refIds.length) {
      const rows = await db.sql<{ id: string; page_id: string; s3_key: string; filename: string; content_type: string }[]>`
        SELECT id, page_id, s3_key, filename, content_type FROM attachments
        WHERE id = ANY(${db.sql.array([...new Set(refIds)])}) AND status = 'confirmed'`
      for (const a of rows) {
        // Re-check view on the ATTACHMENT's page (a page may reference another
        // page's private attachment — never bundle those bytes).
        if (!(await check(fga, `user:${args.userId}`, 'view', { type: 'page', id: a.page_id }))) continue
        const name = imageEntryName(a.id, a.filename, a.content_type)
        files[`${page.dir}/images/${name}`] = await storage.getObject(a.s3_key)
        entryById.set(a.id, `images/${name}`)
      }
    }
    const md = page.body.replace(ATTACHMENT_REF, (m, alt, id) =>
      entryById.has(id) ? `![${alt}](${entryById.get(id)})` : m,
    )
    files[`${page.dir}/index.md`] = strToU8(md)
  }

  const rootName = safeSegment(tree[0]!.title, 'page')
  // Single page, no bundled images → a plain .md (one file shouldn't need unzipping).
  const onlyMd = Object.keys(files).filter((f) => !f.endsWith('/index.md'))
  if (tree.length === 1 && onlyMd.length === 0) {
    return { filename: `${rootName}.md`, contentType: 'text/markdown; charset=utf-8', body: files[`${tree[0]!.dir}/index.md`]! }
  }
  return { filename: `${rootName}.zip`, contentType: 'application/zip', body: zipSync(files) }
}
