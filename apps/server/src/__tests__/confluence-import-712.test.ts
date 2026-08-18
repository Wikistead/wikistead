// #712 / ADR-227 §6 — the Confluence dialect, measured on the HTML an export actually contains.
//
// The fixture reproduces what Confluence writes rather than clean HTML: the `#main-content` wrapper,
// its information-macro markup for panels, a `brush:` class carrying the code language, a table with
// a merged cell, an attachment link, and a macro (`jira`) that has no Markdown form at all. The last
// one is the point of the slice — a wiki migration that silently swallows a macro loses history
// nobody knows to look for.
//
// The conversion runs BEFORE the shared builder (the archive is rewritten to Markdown), which is
// also what guarantees no raw HTML reaches a page body — so the security property is structural
// rather than a promise, and the assertion below reads the stored body to confirm it.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { zipSync, strToU8 } from 'fflate'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/tenant-db.js'
import { fgaClient, writeTuples, deleteTuples } from '@wikistead/authz'
import { importArchive } from '../import/index.js'
import { confluenceHtmlToMarkdown, looksLikeConfluenceExport } from '../import/confluence.js'
import { LogicalSearchDriver } from '../search/index.js'
import { LogicalStorageDriver } from '../storage/index.js'
import { privateTenant } from './helpers/private-tenant.js'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)

const PAGE_HTML = `<!DOCTYPE html><html><head><title>Runbook</title></head><body>
<div id="main-content">
  <h1>Runbook</h1>
  <p>Restart the <strong>server</strong> with <code>pnpm dev</code>, then see <a href="Onboarding.html">Onboarding</a>.</p>
  <div class="confluence-information-macro confluence-information-macro-warning">
    <p>Do not run this in production.</p>
  </div>
  <div class="code panel" data-macro-name="code">
    <pre class="brush: bash">docker compose up -d
echo done</pre>
  </div>
  <ul><li>first</li><li>second<ul><li>nested</li></ul></li></ul>
  <table>
    <tr><th>Step</th><th colspan="2">Detail</th></tr>
    <tr><td>1</td><td>check</td><td>logs</td></tr>
  </table>
  <div data-macro-name="jira"><p>WIK-42</p></div>
  <p><img src="attachments/123/diagram.png" alt="diagram"></p>
</div>
</body></html>`

const EXPORT: Record<string, Uint8Array> = {
  'index.html': strToU8('<html><body><ul><li><a href="Runbook.html">Runbook</a></li></ul></body></html>'),
  'Runbook.html': strToU8(PAGE_HTML),
  'Onboarding.html': strToU8('<html><body><div id="main-content"><h1>Onboarding</h1><p>Welcome.</p></div></body></html>'),
  'attachments/123/diagram.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]),
}

let db: TenantDb
let dispose: () => Promise<void>
let TENANT: string
let SPACE: string
const USER = 'dev-user'

beforeAll(async () => {
  const t = await privateTenant(admin, 'conf712')
  TENANT = t.id
  dispose = t.dispose
  db = await acquireTenantDb({ id: TENANT, slug: t.slug, plan: 'free', isolation: 'logical' } as never)
  const [space] = await db.sql<{ id: string }[]>`
    INSERT INTO spaces (id, tenant_id, name) VALUES (gen_random_uuid()::text, ${TENANT}, 'Confluence target') RETURNING id`
  SPACE = space!.id
  await admin`DELETE FROM pages WHERE tenant_id = ${TENANT}`
  await writeTuples(fgaClient, [
    { user: `user:${USER}`, relation: 'editor_member', object: `space:${SPACE}` },
    { user: `user:${USER}`, relation: 'manager', object: `space:${SPACE}` },
  ])
}, 120_000)

afterAll(async () => {
  await deleteTuples(fgaClient, [
    { user: `user:${USER}`, relation: 'editor_member', object: `space:${SPACE}` },
    { user: `user:${USER}`, relation: 'manager', object: `space:${SPACE}` },
  ]).catch(() => {})
  await db?.release()
  await dispose?.()
  await admin.end()
  await pool.end()
})

describe('#712: a Confluence HTML export imports as Markdown', () => {
  it('converts the page, names the macro it could not represent, and stores no HTML', async () => {
    const report = await importArchive(
      { db, fga: fgaClient, storage: new LogicalStorageDriver(), driver: new LogicalSearchDriver() },
      zipSync(EXPORT),
      { tenantId: TENANT, spaceId: SPACE, userId: USER, plan: 'free' },
    )

    const rows = await db.sql<{ id: string; title: string; ydoc: Buffer }[]>`
      SELECT id, title, ydoc FROM pages WHERE tenant_id = ${TENANT}`
    const titles = rows.map((r) => r.title).sort()
    expect(titles, 'the export index is navigation, not a page').toEqual(['Onboarding', 'Runbook'])

    const Y = await import('yjs')
    const doc = new Y.Doc()
    Y.applyUpdate(doc, new Uint8Array(rows.find((r) => r.title === 'Runbook')!.ydoc))
    const body = doc.getText('content').toString()

    // The structural claim: what is stored is Markdown, so nothing can execute at render time.
    expect(body, 'no raw HTML reached the body').not.toMatch(/<div|<table|<script/i)

    expect(body, 'heading').toContain('# Runbook')
    // A page link in an export points at `Other.html`; after import it must point at the page that
    // file became, or every internal link in a migrated wiki is dead on arrival.
    const onboardingId = rows.find((r) => r.title === 'Onboarding')!.id
    expect(body, 'the internal page link resolved').toContain(`[Onboarding](/p/${onboardingId})`)
    expect(body, 'inline emphasis and code').toContain('Restart the **server** with `pnpm dev`')
    expect(body, 'the warning macro became the product\'s own directive').toContain(':::warning')
    expect(body, 'the code macro kept its language').toContain('```bash')
    expect(body, 'nested list').toMatch(/- second\n {2}- nested/)
    expect(body, 'table header').toContain('| Step | Detail |')
    // The macro with no Markdown form is visible AND named, rather than deleted.
    expect(body, 'the unrepresentable macro leaves a marker').toContain('[Confluence macro: jira]')
    const what = report.degraded.map((d) => d.what)
    expect(what, 'and the report says so').toContain('Confluence macro has no equivalent')
    expect(what, 'the merged cell is reported too').toContain('merged table cells flattened')

    expect(report.published, 'import never publishes').toBe(0)
  }, 180_000)
})

describe('#712: the Confluence conversion, as a function', () => {
  it('detects the export shape and ignores a folder of plain Markdown', () => {
    expect(looksLikeConfluenceExport(['index.html', 'Runbook.html'])).toBe(true)
    expect(looksLikeConfluenceExport(['Home.md', 'Projects/Roadmap.md'])).toBe(false)
  })

  it('reports the macro by NAME so the report can be acted on', () => {
    const { markdown, degraded } = confluenceHtmlToMarkdown('<div data-macro-name="jira"><p>WIK-1</p></div>', 'T')
    expect(markdown).toContain('[Confluence macro: jira]')
    expect(degraded[0]).toMatchObject({ what: 'Confluence macro has no equivalent', detail: 'jira' })
  })

  it('keeps the macro body rather than replacing it with the marker alone', () => {
    const { markdown } = confluenceHtmlToMarkdown('<div data-macro-name="expand"><p>hidden detail</p></div>', 'T')
    expect(markdown).toContain('hidden detail')
  })

  it('escapes a pipe inside a cell so one value cannot split the row', () => {
    const { markdown } = confluenceHtmlToMarkdown('<table><tr><th>A</th></tr><tr><td>x | y</td></tr></table>', 'T')
    expect(markdown.split('\n')[2]).toBe('| x \\| y |')
  })

  it('a script tag contributes nothing — the converter never carries executable text through', () => {
    const { markdown } = confluenceHtmlToMarkdown('<div id="main-content"><script>alert(1)</script><p>ok</p></div>', 'T')
    expect(markdown).not.toContain('alert')
    expect(markdown).toContain('ok')
  })
})

// Read a created page's canonical body. Each new suite below imports its own tiny archive, so the
// space is cleared first: a fixed tenant slug means a previous run's pages would otherwise answer.
async function freshSpace(): Promise<void> {
  await admin`DELETE FROM pages WHERE tenant_id = ${TENANT}`
}
async function bodyOfPage(title: string): Promise<string> {
  const Y = await import('yjs')
  const [row] = await db.sql<{ ydoc: Buffer }[]>`
    SELECT ydoc FROM pages WHERE tenant_id = ${TENANT} AND title = ${title}`
  expect(row, `page "${title}" was created`).toBeTruthy()
  const doc = new Y.Doc()
  Y.applyUpdate(doc, new Uint8Array(row!.ydoc))
  return doc.getText('content').toString()
}

// ── #712 / the defects the independent verification found ──────────────────────────
//
// Each of these is a MEASURED failure, not a hypothesis, and each has the same shape: the file
// imported, the report said so, and the BODY pointed somewhere the reader cannot follow. A fidelity
// report that counts an import as successful while the page is broken is the exact failure this
// feature exists to prevent, so they are pinned individually.
describe('#712 A: a shared attachment belongs to the archive, not to the first page', () => {
  it('resolves an image referenced from a page that is not the first one', async () => {
    await freshSpace()
    const report = await importArchive(
      { db, fga: fgaClient, storage: new LogicalStorageDriver(), driver: new LogicalSearchDriver() },
      zipSync({
        'index.html': strToU8('<html><body><a href="AAA.html">AAA</a></body></html>'),
        'AAA.html': strToU8('<html><body><h1>AAA</h1><p>no picture here</p></body></html>'),
        'Img.html': strToU8('<html><body><h1>Img</h1><img src="attachments/pic.png" alt="pic"/></body></html>'),
        'attachments/pic.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9, 9]),
      }),
      { tenantId: TENANT, spaceId: SPACE, userId: USER, plan: 'free' },
    )
    expect(report.attachmentsImported, 'the file is imported').toBe(1)
    const body = await bodyOfPage('Img')
    // The defect: `attachments/pic.png` stayed raw because the collector hung the file on the FIRST
    // root, and only that page's own map could resolve it.
    expect(body, 'the referencing page points at the stored attachment').toMatch(/wks-attachment:/)
    expect(body, 'and not at the archive-relative path').not.toContain('attachments/pic.png')
  }, 300_000)
})

describe('#712 C: a Confluence import never writes notation this product cannot parse', () => {
  it('turns a link to a page outside the export into text, and reports it', async () => {
    await freshSpace()
    const report = await importArchive(
      { db, fga: fgaClient, storage: new LogicalStorageDriver(), driver: new LogicalSearchDriver() },
      zipSync({
        'index.html': strToU8('<html><body>nav</body></html>'),
        'Here.html': strToU8('<html><body><h1>Here</h1><p>See <a href="Gone.html">gone</a>.</p></body></html>'),
      }),
      { tenantId: TENANT, spaceId: SPACE, userId: USER, plan: 'free' },
    )
    const body = await bodyOfPage('Here')
    expect(body, 'no wikilink notation reaches the reader').not.toMatch(/\[\[/)
    expect(body, 'the words survive as text').toContain('gone')
    expect(report.degraded.map((d) => d.what).join(' '), 'and the lost link is named')
      .toMatch(/outside the export/)
  }, 300_000)
})

describe('#712 F: the Confluence macro people actually use converts', () => {
  it('renders an information macro as a callout, not as an unrepresentable quote', async () => {
    await freshSpace()
    const report = await importArchive(
      { db, fga: fgaClient, storage: new LogicalStorageDriver(), driver: new LogicalSearchDriver() },
      zipSync({
        'index.html': strToU8('<html><body>nav</body></html>'),
        'Info.html': strToU8('<html><body><h1>Info</h1><div class="confluence-information-macro confluence-information-macro-information"><p>Read this first.</p></div></body></html>'),
      }),
      { tenantId: TENANT, spaceId: SPACE, userId: USER, plan: 'free' },
    )
    const body = await bodyOfPage('Info')
    expect(body, 'it becomes a note callout').toContain(':::note')
    expect(body).toContain('Read this first.')
    expect(report.degraded.map((d) => d.detail ?? '').join(' '), 'and is not reported as unrepresentable')
      .not.toContain('information')
  }, 300_000)
})

describe('#712 B: an attachment LINK is not silently dead', () => {
  it('names the file it could not re-point', async () => {
    await freshSpace()
    const report = await importArchive(
      { db, fga: fgaClient, storage: new LogicalStorageDriver(), driver: new LogicalSearchDriver() },
      zipSync({
        'index.html': strToU8('<html><body>nav</body></html>'),
        'Doc.html': strToU8('<html><body><h1>Doc</h1><p><a href="attachments/paper.pdf">the paper</a></p></body></html>'),
        'attachments/paper.pdf': strToU8('%PDF-1.4 fake'),
      }),
      { tenantId: TENANT, spaceId: SPACE, userId: USER, plan: 'free' },
    )
    expect(report.degraded.map((d) => `${d.what} ${d.detail ?? ''}`).join('\n'), 'the dead file link is named')
      .toMatch(/attached file[\s\S]*paper\.pdf|paper\.pdf/)
  }, 300_000)
})

describe('#712 E: Confluence shapes GFM can carry are carried', () => {
  it('keeps strikethrough and the state of a task list', async () => {
    const { markdown } = confluenceHtmlToMarkdown(
      '<html><body><h1>T</h1><p>this is <s>gone</s> now</p>' +
      '<ul class="inline-task-list"><li class="checked">shipped</li><li class="unchecked">pending</li></ul>' +
      '</body></html>', 'T')
    expect(markdown, 'strikethrough survives as GFM').toContain('~~gone~~')
    expect(markdown, 'a done task is a ticked box').toContain('- [x] shipped')
    expect(markdown, 'an open task is an empty box').toContain('- [ ] pending')
  })

  it('leaves an ordinary list alone', () => {
    const { markdown } = confluenceHtmlToMarkdown('<html><body><ul><li>one</li><li>two</li></ul></body></html>', 'T')
    expect(markdown).toContain('- one')
    expect(markdown).not.toContain('- [ ]')
  })
})
