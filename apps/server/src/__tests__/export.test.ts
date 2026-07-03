// Integration tests — real Postgres + real OpenFGA + real storage (SeaweedFS), no
// mocks. P5 export: view-filtered subtree, image bundling + link rewrite, the
// getObject auth boundary, and zip-slip sanitization.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import * as Y from 'yjs'
import { unzipSync, strFromU8 } from 'fflate'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { fgaClient, writeTuples, deleteTuples } from '@wikistead/authz'
import { LogicalStorageDriver } from '../storage/index.js'
import { buildExport } from '../export/index.js'
import { buildHtmlExport } from '../render/html-export.js'
import type { Tenant } from '@wikistead/types'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const storage = new LogicalStorageDriver()
const TENANT = 'tenant_dev'
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'free', isolation: 'logical' }) as Tenant
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')

let db: TenantDb
// ids
const SPACE = 'exp-space'
const ROOT = 'exp-root', CHILD = 'exp-child', HIDDEN = 'exp-hidden', OTHER = 'exp-other', XSS = 'exp-xss', DEGRADE = 'exp-degrade'
const ATT = 'exp-att-ok', FORBIDDEN_ATT = 'exp-att-forbidden'
const USER = 'exp-user'

const ydoc = (text: string) => Buffer.from(Y.encodeStateAsUpdate((() => { const d = new Y.Doc(); d.getText('content').insert(0, text); return d })()))
const grants = [
  { user: `user:${USER}`, relation: 'view_base', object: `page:${ROOT}` },
  { user: `user:${USER}`, relation: 'view_base', object: `page:${CHILD}` },
  { user: `user:${USER}`, relation: 'view_base', object: `page:${XSS}` },
  { user: `user:${USER}`, relation: 'view_base', object: `page:${DEGRADE}` },
  // NOTE: no grants for HIDDEN or OTHER → not viewable by USER.
]

async function putObject(key: string) {
  const url = await storage.presignPut(key, { contentType: 'image/png', ttlSeconds: 300 })
  const r = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: PNG })
  if (!r.ok) throw new Error(`PUT ${r.status}`)
}

beforeAll(async () => {
  await storage.ensureBucket()
  db = await acquireTenantDb(asTenant(TENANT))
  await admin`INSERT INTO spaces (id, tenant_id, name) VALUES (${SPACE}, ${TENANT}, 'Export Space') ON CONFLICT (id) DO NOTHING`
  const rootBody = `# Root page\n\n![diagram](wks-attachment:${ATT})\n\n![secret](wks-attachment:${FORBIDDEN_ATT})\n`
  // Export reads the PUBLISHED content (published_md), not the draft ydoc — so these
  // fixtures set published_md to the body (the draft/publish model: a page must be
  // published to export). ydoc is set too, mirroring a real published page.
  const childBody = '## Child page body', hiddenBody = '## secret child body', otherBody = '## other'
  // A page whose PUBLISHED markdown carries raw XSS — the HTML export must neutralise it end-to-end
  // (proving the render→sanitize path, not just the sanitizer unit).
  // Raw HTML (escaped by the renderer) + a `:::table` whose cell carries a <script> (the table
  // macro emits trusted HTML via unsafeHtml → the FINAL sanitizer must still strip it: raw
  // passthrough is zero even through the trusted-HTML path).
  const xssBody = [
    '# Hello',
    '',
    '<img src=x onerror="steal()">',
    '',
    '[link](javascript:alert(1))',
    '',
    ':::table',
    '| a | b |',
    '| - | - |',
    '| <script>alert(document.cookie)</script> | ok |',
    ':::',
    '',
  ].join('\n')
  await admin`INSERT INTO pages (id, tenant_id, space_id, parent_id, title, ydoc, published_md) VALUES
    (${ROOT},   ${TENANT}, ${SPACE}, NULL,    'Root Page',   ${ydoc(rootBody)},   ${rootBody}),
    (${CHILD},  ${TENANT}, ${SPACE}, ${ROOT}, 'Child Page',  ${ydoc(childBody)},  ${childBody}),
    (${HIDDEN}, ${TENANT}, ${SPACE}, ${ROOT}, 'Secret Child',${ydoc(hiddenBody)}, ${hiddenBody}),
    (${OTHER},  ${TENANT}, ${SPACE}, NULL,    'Other Page',  ${ydoc(otherBody)},  ${otherBody}),
    (${XSS},    ${TENANT}, ${SPACE}, NULL,    'XSS Page',    ${ydoc(xssBody)},    ${xssBody})
    ON CONFLICT (id) DO NOTHING`
  // A page with a DEGRADE macro (plantuml renders to source server-side) → the HTML export must wrap
  // it with the fidelity indicator (#85 (c)).
  const degradeBody = '# Diagram\n\n```plantuml\n@startuml\nA -> B\n@enduml\n```\n'
  await admin`INSERT INTO pages (id, tenant_id, space_id, parent_id, title, ydoc, published_md) VALUES
    (${DEGRADE}, ${TENANT}, ${SPACE}, NULL, 'Degrade Page', ${ydoc(degradeBody)}, ${degradeBody})
    ON CONFLICT (id) DO NOTHING`
  // ATT belongs to ROOT (viewable). FORBIDDEN_ATT belongs to OTHER (not viewable).
  // ATT's filename is a zip-slip attempt.
  const k1 = `${TENANT}/exp/${ATT}.png`, k2 = `${TENANT}/exp/${FORBIDDEN_ATT}.png`
  await putObject(k1); await putObject(k2)
  await admin`INSERT INTO attachments (id, tenant_id, page_id, filename, content_type, s3_key, status, size_bytes, confirmed_at) VALUES
    (${ATT},           ${TENANT}, ${ROOT},  '../../evil.png', 'image/png', ${k1}, 'confirmed', ${PNG.length}, now()),
    (${FORBIDDEN_ATT}, ${TENANT}, ${OTHER}, 'secret.png',     'image/png', ${k2}, 'confirmed', ${PNG.length}, now())
    ON CONFLICT (id) DO NOTHING`
  await writeTuples(fgaClient, grants)
})

afterAll(async () => {
  await deleteTuples(fgaClient, grants).catch(() => {})
  await admin`DELETE FROM attachments WHERE tenant_id = ${TENANT} AND id LIKE 'exp-att%'`.catch(() => {})
  await admin`DELETE FROM pages WHERE id IN (${ROOT}, ${CHILD}, ${HIDDEN}, ${OTHER}, ${XSS}, ${DEGRADE})`.catch(() => {})
  await admin`DELETE FROM spaces WHERE id = ${SPACE}`.catch(() => {})
  await db.release()
  await admin.end()
  await pool.end()
})

describe('buildExport', () => {
  it('returns null when the root is not viewable (→ 404)', async () => {
    expect(await buildExport(db, fgaClient, storage, { userId: 'nobody-xyz', rootId: ROOT })).toBeNull()
  })

  it('exports the view-authorized subtree, omitting unviewable subpages (no leak)', async () => {
    const res = await buildExport(db, fgaClient, storage, { userId: USER, rootId: ROOT })
    expect(res!.filename).toMatch(/\.zip$/)
    const entries = Object.keys(unzipSync(res!.body))
    // root + viewable child present; the secret child is absent, and its title never appears.
    expect(entries.filter((e) => e.endsWith('index.md')).length).toBe(2) // root + child only
    expect(entries.join('\n')).toContain('Child Page')
    expect(entries.join('\n')).not.toContain('Secret Child')
  })

  it('bundles authorized images (relative path), never a presigned URL, and enforces the getObject auth boundary', async () => {
    const res = await buildExport(db, fgaClient, storage, { userId: USER, rootId: ROOT })
    const zip = unzipSync(res!.body)
    const rootKey = Object.keys(zip).find((k) => k.endsWith('/index.md') && /Root/.test(k))!
    const rootMd = strFromU8(zip[rootKey]!)
    // authorized image rewritten to a relative path; bundled bytes present.
    expect(rootMd).toContain(`images/${ATT}.png`)
    expect(Object.keys(zip).some((k) => k.endsWith(`images/${ATT}.png`))).toBe(true)
    // FORBIDDEN_ATT belongs to a non-viewable page → NOT bundled, ref left untouched.
    expect(Object.keys(zip).some((k) => k.includes(FORBIDDEN_ATT))).toBe(false)
    expect(rootMd).toContain(`wks-attachment:${FORBIDDEN_ATT}`)
    // no presigned URL leaked in ANY markdown entry.
    for (const [name, bytes] of Object.entries(zip)) {
      if (name.endsWith('.md')) expect(strFromU8(bytes)).not.toMatch(/https?:\/\/|X-Amz-/i)
    }
  })

  it('sanitizes zip entry names (zip-slip): no ".." despite a malicious attachment filename', async () => {
    const res = await buildExport(db, fgaClient, storage, { userId: USER, rootId: ROOT })
    const entries = Object.keys(unzipSync(res!.body))
    expect(entries.every((e) => !e.includes('..'))).toBe(true)
    // the "../../evil.png" attachment became images/<id>.png
    expect(entries.some((e) => e.endsWith(`images/${ATT}.png`))).toBe(true)
  })

  it('a lone page with no images exports as a plain .md', async () => {
    const res = await buildExport(db, fgaClient, storage, { userId: USER, rootId: CHILD })
    expect(res!.filename).toMatch(/\.md$/)
    expect(res!.contentType).toContain('text/markdown')
    expect(strFromU8(res!.body)).toContain('Child page body')
  })
})

// #85 / ADR-059: single-page HTML export through the shared render→sanitize path. Authz mirrors the
// Markdown export (view-gated → null → 404); the final sanitizer neutralises raw XSS end-to-end.
describe('buildHtmlExport', () => {
  it('returns null when the page is not viewable (→ 404)', async () => {
    expect(await buildHtmlExport(db, fgaClient, { userId: 'nobody-xyz', pageId: ROOT })).toBeNull()
  })

  it('does not export a page the user cannot view (no leak of OTHER / HIDDEN)', async () => {
    expect(await buildHtmlExport(db, fgaClient, { userId: USER, pageId: OTHER })).toBeNull()
    expect(await buildHtmlExport(db, fgaClient, { userId: USER, pageId: HIDDEN })).toBeNull()
  })

  it('renders a viewable page to an HTML document (published content, shared renderer)', async () => {
    const res = await buildHtmlExport(db, fgaClient, { userId: USER, pageId: CHILD })
    expect(res!.contentType).toContain('text/html')
    expect(res!.filename).toMatch(/\.html$/)
    expect(res!.body).toContain('<!doctype html>')
    expect(res!.body).toContain('Child page body') // the published_md was rendered
  })

  it('neutralises raw XSS from published_md end-to-end (render → sanitize)', async () => {
    const res = await buildHtmlExport(db, fgaClient, { userId: USER, pageId: XSS })
    const html = res!.body
    const lc = html.toLowerCase()
    expect(html).toContain('Hello') // benign content survives
    // No EXECUTABLE script tag anywhere (a `:::table` cell script must not survive the final pass —
    // proving raw passthrough is zero even through the trusted table-HTML path).
    expect(lc).not.toContain('<script')
    expect(html).not.toContain('document.cookie')
    // Raw inline HTML from markdown is escaped to inert text (never a live onerror-bearing element).
    expect(lc).not.toContain('<img src=x onerror')
    // A `javascript:` link href is dropped by the renderer's scheme allowlist.
    expect(lc).not.toContain('javascript:')
  })

  it('wraps a degrade macro with a VISIBLE fidelity indicator (#85 (c))', async () => {
    const res = await buildHtmlExport(db, fgaClient, { userId: USER, pageId: DEGRADE })
    const html = res!.body
    expect(html).toContain('wks-fidelity-degrade') // the degraded block is wrapped
    expect(html).toContain('wks-fidelity-badge') // ...with the badge element
    expect(html).toContain('.wks-fidelity-badge') // ...and the document ships the CSS so it's visible
    expect(html).toContain('Diagram') // the surrounding prose still renders
  })
})
