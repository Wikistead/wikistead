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
