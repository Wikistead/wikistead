// Integration tests — real Postgres + real OpenFGA + real storage (SeaweedFS), no
// mocks. P5 export: view-filtered subtree, image bundling + link rewrite, the
// getObject auth boundary, and zip-slip sanitization.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import * as Y from 'yjs'
import { unzipSync, strFromU8 } from 'fflate'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { fgaClient, writeTuples, deleteTuples, check } from '@wikistead/authz'
import { LogicalStorageDriver } from '../storage/index.js'
import { buildExport, buildSpaceExport, buildTenantExport, buildSelectionExport, SELECTION_EXPORT_CAP } from '../export/index.js'
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
// #85: a page whose BODY is a dynamic `:::children` list, over one viewable and one unviewable child.
const LISTS = 'exp-lists', LIST_OK = 'exp-list-ok', LIST_SECRET = 'exp-list-secret'
const ATT = 'exp-att-ok', FORBIDDEN_ATT = 'exp-att-forbidden'
const USER = 'exp-user'

const ydoc = (text: string) => Buffer.from(Y.encodeStateAsUpdate((() => { const d = new Y.Doc(); d.getText('content').insert(0, text); return d })()))
const grants = [
  { user: `user:${USER}`, relation: 'view_direct', object: `page:${ROOT}` },
  { user: `user:${USER}`, relation: 'view_direct', object: `page:${CHILD}` },
  { user: `user:${USER}`, relation: 'view_direct', object: `page:${XSS}` },
  { user: `user:${USER}`, relation: 'view_direct', object: `page:${DEGRADE}` },
  { user: `user:${USER}`, relation: 'view_direct', object: `page:${LISTS}` },
  { user: `user:${USER}`, relation: 'view_direct', object: `page:${LIST_OK}` },
  // NOTE: no grant for LIST_SECRET → it must not reach the exported list.
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
  // #85: a page whose published body is a `:::children` list. Both children are PUBLISHED (the list only
  // considers published pages); only one is viewable by USER, so the export must show exactly one.
  const listsBody = '# Lists\n\n:::children\n:::\n'
  await admin`INSERT INTO pages (id, tenant_id, space_id, parent_id, title, ydoc, published_md, published_at) VALUES
    (${LISTS},       ${TENANT}, ${SPACE}, NULL,     'Lists Page',   ${ydoc(listsBody)}, ${listsBody}, now()),
    (${LIST_OK},     ${TENANT}, ${SPACE}, ${LISTS}, 'Visible Note', ${ydoc('ok')},      'ok',          now()),
    (${LIST_SECRET}, ${TENANT}, ${SPACE}, ${LISTS}, 'Secret Note',  ${ydoc('no')},      'no',          now())
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
  await admin`DELETE FROM pages WHERE id IN (${ROOT}, ${CHILD}, ${HIDDEN}, ${OTHER}, ${XSS}, ${DEGRADE}, ${LIST_OK}, ${LIST_SECRET}, ${LISTS})`.catch(() => {})
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

  // #308 / ADR-132: the round-trip manifest. It carries oldId→dir→title→published for every EXPORTED page —
  // and ONLY exported pages, so it never becomes a title-leak side channel for a view-filtered page.
  it('writes a manifest.json mapping oldId→dir→title→published, and NEVER lists a view-filtered page', async () => {
    const res = await buildExport(db, fgaClient, storage, { userId: USER, rootId: ROOT })
    const zip = unzipSync(res!.body)
    expect(Object.keys(zip)).toContain('manifest.json')
    const manifest = JSON.parse(strFromU8(zip['manifest.json']!)) as { formatVersion: number; pages: { oldId: string; dir: string; title: string; published: boolean }[] }
    expect(manifest.formatVersion).toBe(1)
    const byId = new Map(manifest.pages.map((p) => [p.oldId, p]))
    // the two viewable pages are mapped with EXACT titles + their zip dir (the lossless round-trip payload).
    expect(byId.get(ROOT)).toMatchObject({ title: 'Root Page', published: true })
    expect(byId.get(CHILD)).toMatchObject({ title: 'Child Page', published: true })
    expect(byId.get(ROOT)!.dir).toBe(Object.keys(zip).find((k) => k.endsWith('/index.md') && /Root/.test(k))!.replace(/\/index\.md$/, ''))
    // the unviewable secret child is absent from the manifest too — no title leak via the round-trip file.
    expect(byId.has(HIDDEN)).toBe(false)
    expect(strFromU8(zip['manifest.json']!)).not.toContain('Secret Child')
  })
})

// #309: whole-space / whole-tenant Markdown ZIP export. Reuses the per-page collect+bundle path (so the
// per-page view-filter + image auth boundary are already covered by buildExport above); these tests pin the
// NEW authz surface — the space `view` gate (existence-hiding 404) and the space-level view-filter of a tenant
// export. A SECOND user with space `viewer` (not the page-grant USER) so the buildExport fixtures stay intact.
describe('buildSpaceExport / buildTenantExport (#309)', () => {
  const SPACE_USER = 'exp-user2', SPACE2 = 'exp-space2', PAGE2 = 'exp-p2'
  // #309 authz anti-test fixtures: a PRIVATE page (ADR-098) and a RESTRICTED page (ADR-072) in SPACE — a space
  // VIEWER must NOT be able to export them (the `but not private` / `but not restricted` cut survives the
  // space-level access). Regression guard against a future "space is gated → skip per-node checks" shortcut.
  const PRIV = 'exp-priv', REST = 'exp-rest'
  const spaceGrants = [
    { user: `user:${SPACE_USER}`, relation: 'viewer', object: `space:${SPACE}` }, // views SPACE, NOT SPACE2
    // Link the fixture pages to their space (page#space) so the `viewer from space` inheritance resolves — a
    // real page carries this; the direct-SQL fixtures don't, so add it here (scoped to these tests).
    ...[ROOT, CHILD, HIDDEN, OTHER, XSS, DEGRADE, PRIV, REST].map((id) => ({ user: `space:${SPACE}`, relation: 'space', object: `page:${id}` })),
    { user: `space:${SPACE2}`, relation: 'space', object: `page:${PAGE2}` },
    // PRIV is private (marker written as the user:* / share_link:* pair, like setPagePrivate).
    { user: 'user:*', relation: 'private', object: `page:${PRIV}` },
    { user: 'share_link:*', relation: 'private', object: `page:${PRIV}` },
    // REST is restricted for SPACE_USER specifically (deny wins over the space grant).
    { user: `user:${SPACE_USER}`, relation: 'restricted', object: `page:${REST}` },
  ]
  beforeAll(async () => {
    await admin`INSERT INTO spaces (id, tenant_id, name) VALUES (${SPACE2}, ${TENANT}, 'Second Space') ON CONFLICT (id) DO NOTHING`
    await admin`INSERT INTO pages (id, tenant_id, space_id, parent_id, title, ydoc, published_md) VALUES
      (${PAGE2}, ${TENANT}, ${SPACE2}, NULL, 'Second Space Page', ${ydoc('## second')}, '## second space body'),
      (${PRIV},  ${TENANT}, ${SPACE},  NULL, 'Private Page',      ${ydoc('## private')}, '## private body'),
      (${REST},  ${TENANT}, ${SPACE},  NULL, 'Restricted Page',   ${ydoc('## restricted')}, '## restricted body')
      ON CONFLICT (id) DO NOTHING`
    await writeTuples(fgaClient, spaceGrants)
  })
  afterAll(async () => {
    await deleteTuples(fgaClient, spaceGrants).catch(() => {})
    await admin`DELETE FROM pages WHERE id IN (${PAGE2}, ${PRIV}, ${REST})`.catch(() => {})
    await admin`DELETE FROM spaces WHERE id = ${SPACE2}`.catch(() => {})
  })

  // #511 / ADR-185 (slice 4): exporting a SELECTION from the Pages tab. The gate is per-page `view`, the same
  // one the per-page export uses — a page the caller cannot view is OMITTED, never exported and never turned
  // into an error that would confirm it exists. These reuse the private / restricted fixtures above, which is
  // the point: the space grant must not become a shortcut past the per-node cut for a selected id either.
  it('buildSelectionExport bundles only the SELECTED pages, with their subtree', async () => {
    const res = await buildSelectionExport(db, fgaClient, storage, { userId: SPACE_USER, spaceId: SPACE, pageIds: [ROOT] })
    const entries = Object.keys(unzipSync(res!.body)).join('\n')
    expect(res!.filename).toBe('Export Space-selection.zip')
    expect(entries, 'the selected root and its viewable child are in').toMatch(/Root Page/)
    expect(entries, 'a page that was NOT selected stays out').not.toMatch(/Second Space Page/)
  })

  it('buildSelectionExport OMITS a selected page the caller cannot view (private / restricted)', async () => {
    const res = await buildSelectionExport(db, fgaClient, storage, {
      userId: SPACE_USER, spaceId: SPACE, pageIds: [ROOT, PRIV, REST],
    })
    const entries = Object.keys(unzipSync(res!.body)).join('\n')
    expect(entries, 'the viewable selection is exported').toMatch(/Root Page/)
    // The space grant does NOT reach a private page (`but not private`) nor a restricted one — selecting them
    // must not export them, and must not error either (omission, not an existence oracle).
    expect(entries, 'the private page is not in the archive').not.toMatch(/Private Page/)
    expect(entries, 'the restricted page is not in the archive').not.toMatch(/Restricted Page/)
  })

  it('buildSelectionExport ignores ids from another space, and 404s for a space the caller cannot view', async () => {
    //this used to pass for the WRONG reason. PAGE2 was unviewable, so collectTree's per-page
    // `view` gate dropped it and the space filter was never exercised — I had reported the filter as
    // mere defence in depth on that evidence, which was a fixture artefact, not a fact. Grant the caller
    // a direct view of PAGE2 first: now the ONLY thing keeping another space's page out of THIS space's
    // archive is the space_id condition in the pre-pass SELECT.
    const crossGrant = [{ user: `user:${SPACE_USER}`, relation: 'view_direct', object: `page:${PAGE2}` }]
    await writeTuples(fgaClient, crossGrant).catch(() => {})
    try {
      expect(await check(fgaClient, `user:${SPACE_USER}`, 'view', { type: 'page', id: PAGE2 }),
        'the caller CAN view it — so the view gate cannot be what excludes it').toBe(true)
      const res = await buildSelectionExport(db, fgaClient, storage, { userId: SPACE_USER, spaceId: SPACE, pageIds: [PAGE2] })
      expect(Object.keys(unzipSync(res!.body)), 'an id outside this space contributes nothing').toEqual([])
      expect(await buildSelectionExport(db, fgaClient, storage, { userId: SPACE_USER, spaceId: SPACE2, pageIds: [PAGE2] }),
        'a space the caller cannot view is a uniform 404').toBeNull()
    } finally {
      // Hand it back: later cases in this file assert on what SPACE_USER can reach, and a grant left
      // behind would quietly change their meaning.
      await deleteTuples(fgaClient, crossGrant).catch(() => {})
    }
  })

  it('buildSelectionExport enforces the selection cap', async () => {
    const tooMany = Array.from({ length: SELECTION_EXPORT_CAP + 1 }, (_, i) => `sel-${i}`)
    await expect(buildSelectionExport(db, fgaClient, storage, { userId: SPACE_USER, spaceId: SPACE, pageIds: tooMany }))
      .rejects.toMatchObject({ statusCode: 400, reason: 'too_many' })
  })

  it('buildSpaceExport returns null (→ 404) when the space is not viewable', async () => {
    expect(await buildSpaceExport(db, fgaClient, storage, { userId: 'nobody-xyz', spaceId: SPACE })).toBeNull()
    // SPACE_USER can view SPACE but NOT SPACE2 → existence-hiding 404 for the space they can't see.
    expect(await buildSpaceExport(db, fgaClient, storage, { userId: SPACE_USER, spaceId: SPACE2 })).toBeNull()
  })

  it('buildSpaceExport bundles the viewable space as one ZIP (named for the space)', async () => {
    const res = await buildSpaceExport(db, fgaClient, storage, { userId: SPACE_USER, spaceId: SPACE })
    expect(res!.filename).toBe('Export Space.zip')
    const entries = Object.keys(unzipSync(res!.body)).join('\n')
    // space viewer sees every page in the space → all roots + children present (multiple top-level dirs).
    expect(entries).toContain('Root Page')
    expect(entries).toContain('Child Page')
    expect(entries).toContain('Other Page')
    // and NOTHING from the other space (that's a different export).
    expect(entries).not.toContain('Second Space Page')
  })

  it('view-filters PRIVATE (ADR-098) and RESTRICTED (ADR-072) pages out of a space export, even for a space VIEWER', async () => {
    const res = await buildSpaceExport(db, fgaClient, storage, { userId: SPACE_USER, spaceId: SPACE })
    const entries = Object.keys(unzipSync(res!.body)).join('\n')
    // SPACE_USER is a space viewer, yet the private page (but not private) and the restricted page
    // (but not restricted) are cut — the per-node view check survives the space-level access. No leak.
    expect(entries).not.toContain('Private Page')
    expect(entries).not.toContain('Restricted Page')
    // sanity: a normal page in the same space IS present (so the omission is the cut, not an empty export).
    expect(entries).toContain('Root Page')
  })

  it('buildTenantExport includes ONLY the spaces the caller can view (view-filtered, no leak)', async () => {
    const res = await buildTenantExport(db, fgaClient, storage, { userId: SPACE_USER })
    expect(res.filename).toBe('workspace.zip')
    const entries = Object.keys(unzipSync(res.body)).join('\n')
    // SPACE (viewable) is present under its own directory; SPACE2 (not viewable) is absent — existence hidden.
    expect(entries).toContain('Export Space/Root Page')
    expect(entries).not.toContain('Second Space')
    expect(entries).not.toContain(PAGE2)
  })

  it('buildTenantExport for a user who can view nothing yields an empty archive (no leak, no manifest)', async () => {
    const res = await buildTenantExport(db, fgaClient, storage, { userId: 'nobody-xyz' })
    const entries = Object.keys(unzipSync(res.body))
    expect(entries.length).toBe(0) // not even a manifest.json — an empty export carries nothing
  })

  // #308 / ADR-132: the space manifest must NOT list private/restricted pages either — the manifest is built
  // from the SAME view-filtered tree, so its titles never become a side channel around the view cut.
  it('the space export manifest omits PRIVATE and RESTRICTED pages (no title leak via the round-trip file)', async () => {
    const res = await buildSpaceExport(db, fgaClient, storage, { userId: SPACE_USER, spaceId: SPACE })
    const zip = unzipSync(res!.body)
    const manifest = JSON.parse(strFromU8(zip['manifest.json']!)) as { pages: { title: string }[] }
    const titles = manifest.pages.map((p) => p.title)
    expect(titles).toContain('Root Page')
    expect(titles).not.toContain('Private Page')
    expect(titles).not.toContain('Restricted Page')
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

  // #422the align FIX was false-green — the unit test asserted the wrapper CLASS existed in the
  // render fragment, never that the finished document styles it. The export is self-contained, so the
  // app bundle's copy of the #267 align rules is not there: the wrapper was inert and export/print
  // showed no alignment at all. Pin the whole pipeline — wrapper survives the sanitizer AND the
  // document carries the rule that makes it do something.
  it('#422: an aligned block survives the sanitizer AND the export document styles it', async () => {
    const [before] = await admin<[{ published_md: string | null }]>`SELECT published_md FROM pages WHERE id = ${CHILD}`
    await admin`UPDATE pages SET published_md = ${':::table{align=right}\n<table><tbody><tr><td>x</td></tr></tbody></table>\n:::\n'} WHERE id = ${CHILD}`
    try {
      const res = await buildHtmlExport(db, fgaClient, { userId: USER, pageId: CHILD })
      const doc = res!.body
      // 1. the wrapper reached the FINAL document (the sanitizer keeps class-only styling hooks)
      expect(doc, 'the align wrapper survives sanitize').toContain('class="cm-lp-align-right"')
      // 2. …and the document defines what that class DOES (the half that was missing)
      expect(doc, 'the export stylesheet aligns it').toContain('.cm-lp-align-right{display:flex;flex-direction:column;align-items:flex-end;}')
      expect(doc).toContain('.cm-lp-align-left{display:flex;flex-direction:column;align-items:flex-start;}')

      // The same wrapper on an aligned DIAGRAM fence. This used to assert the OPPOSITE — that mermaid
      // carried no badge — on the grounds that its fence round-trips verbatim in Markdown. True of the
      // `.md`, but this document is the RENDER, and here the diagram is not drawn at all (ADR-059 fixes
      // mermaid as degrade server-side: no headless render, no mermaid JS in exported HTML). So the
      // aligned fence keeps its <pre> AND now wears the badge that says the block was simplified.
      await admin`UPDATE pages SET published_md = ${'```mermaid align=left\nflowchart TD\n  A-->B\n```\n'} WHERE id = ${CHILD}`
      const diagram = (await buildHtmlExport(db, fgaClient, { userId: USER, pageId: CHILD }))!.body
      expect(diagram, 'the diagram fence is aligned too').toContain('class="cm-lp-align-left"')
      expect(diagram).toContain('<pre class="mermaid">')
      // check the BODY, not the whole document — the stylesheet always defines .wks-fidelity-degrade
      expect(diagram.split('</head>')[1] ?? '', 'a diagram that cannot be drawn statically says so').toContain('wks-fidelity-degrade')
    } finally {
      await admin`UPDATE pages SET published_md = ${before!.published_md} WHERE id = ${CHILD}`
    }
  })

  // A callout's `[label]` is its TITLE on screen. calloutHtmlRender ignored the parameter, so every
  // server-rendered surface — published page, HTML export, and the print/PDF document built from it —
  // dropped it silently: `:::note[Deploy checklist]` arrived as an untitled note. Content loss, not
  // styling. (details' <summary> already used the same threaded label, which is what made the gap
  // visible.) Pinned end to end: the title reaches the document, is styled, and stays inert text.
  it('a callout keeps its [label] as a title in the export (and the label is escaped)', async () => {
    const [before] = await admin<[{ published_md: string | null }]>`SELECT published_md FROM pages WHERE id = ${CHILD}`
    await admin`UPDATE pages SET published_md = ${':::note[Deploy checklist]\nremember the migration\n:::\n\n:::tip[<img src=x onerror=alert(1)>]\nescaped\n:::\n'} WHERE id = ${CHILD}`
    try {
      const doc = (await buildHtmlExport(db, fgaClient, { userId: USER, pageId: CHILD }))!.body
      expect(doc, 'the label survives as the callout title').toContain('<div class="callout-title">Deploy checklist</div>')
      expect(doc, 'the export styles that title').toContain('.callout-title{')
      expect(doc, 'the body is still rendered').toContain('remember the migration')
      // the label is TEXT, never markup — the same boundary the rest of the renderer keeps
      expect(doc).not.toContain('<img src=x')
      expect(doc).toContain('&lt;img src=x')
    } finally {
      await admin`UPDATE pages SET published_md = ${before!.published_md} WHERE id = ${CHILD}`
    }
  })

  it('ships the editor-matching stylesheet so the export looks like the app (#85 bounce 635)', async () => {
    const res = await buildHtmlExport(db, fgaClient, { userId: USER, pageId: CHILD })
    const css = res!.body
    // callouts reproduce the editor look: per-type colour + a masked icon (the ⚠ etc.)
    expect(css).toContain('.callout-warning')
    expect(css).toContain('--callout-warning')
    expect(css).toContain('mask:var(--cb-icon)')
    // headings match the editor sizes/colour (not plain text)
    expect(css).toContain('.wks-export h1{font-size:1.8em}')
    expect(css).toContain('--head') // heading colour token (green, like the editor)
    // dark theme is handled
    expect(css).toContain('prefers-color-scheme:dark')
    // #207 part 2: this document IS what the app prints (offscreen frame, all macros static). It must
    // carry its OWN print rules so the printed output uses the full sheet (release the narrow reading
    // column) with a compact even margin — else printing the export reintroduces #207 part 1's
    // oversized margins. (part 2's macro rendering is the shared #85 renderer, covered above/below.)
    expect(css).toContain('@page{margin:14mm;}')
    expect(css).toContain('@media print')
    expect(css).toContain('.wks-export{max-width:none')
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

  // #85 / ADR-145: `:::tagged` and `:::children` are resolved by the CLIENT on the member surface, so this
  // DOM-free path rendered the bare directive — an empty box where the reader sees a list of pages. Since
  // ADR-191 folded print onto this renderer, that empty box is what a member PRINTED. The export resolves
  // the list for the exporting viewer; the per-item view filter is the same one the live list uses, so the
  // list can never grow a page the viewer could not open.
  it('resolves a dynamic :::children list for the exporting viewer — and only their viewable pages', async () => {
    const res = await buildHtmlExport(db, fgaClient, { userId: USER, pageId: LISTS })
    const body = (res!.body.split('</head>')[1] ?? '')
    expect(body, 'the viewable child is listed, as a link').toContain('Visible Note')
    expect(body).toContain(`href="/p/${LIST_OK}"`)
    expect(body, 'an unviewable child never appears — not its title, not its id').not.toContain('Secret Note')
    expect(body).not.toContain(LIST_SECRET)
    expect(body, 'the directive itself is gone, not passed through as text').not.toContain(':::children')
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
