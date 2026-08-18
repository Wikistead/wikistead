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

// ── #712/the defects the independent verification found ──────────────────────────
//
// Each of these is a MEASURED failure, not a hypothesis, and each has the same shape: the file
// imported, the report said so, and the BODY pointed somewhere the reader cannot follow. A fidelity
// report that counts an import as successful while the page is broken is the exact failure this
// feature exists to prevent, so they are pinned individually.
describe('#712A: a shared attachment belongs to the archive, not to the first page', () => {
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

describe('#712C: a Confluence import never writes notation this product cannot parse', () => {
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

describe('#712F: the Confluence macro people actually use converts', () => {
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

describe('#712B: an attachment LINK reaches the file it names', () => {
  //① closed: the link is now RE-POINTED rather than reported as lost. Reporting it was the
  // half that could be done at parse time (the attachment id does not exist until materialisation);
  // the rewrite pass has the id, so the link becomes the product's own file notation.
  it('re-points a link to a file the archive carries', async () => {
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
    const body = await bodyOfPage('Doc')
    expect(body, 'the link points at the imported attachment, in the notation this product reads (#273)')
      .toMatch(/\[the paper\]\(wks-attachment:[0-9a-f-]+\)/)
    expect(body, 'and no longer at a path the product does not serve').not.toContain('attachments/paper.pdf')
    expect(report.degraded.map((d) => d.what).join('\n'), 'nothing was lost, so nothing is reported lost')
      .not.toMatch(/attached file/)
  }, 300_000)

  it('reports a link to a file the archive does NOT carry (measured, not predicted)', async () => {
    await freshSpace()
    const report = await importArchive(
      { db, fga: fgaClient, storage: new LogicalStorageDriver(), driver: new LogicalSearchDriver() },
      zipSync({
        'index.html': strToU8('<html><body>nav</body></html>'),
        'Doc.html': strToU8('<html><body><h1>Doc</h1><p><a href="attachments/missing.pdf">the paper</a></p></body></html>'),
      }),
      { tenantId: TENANT, spaceId: SPACE, userId: USER, plan: 'free' },
    )
    expect(report.degraded.map((d) => `${d.what} ${d.detail ?? ''}`).join('\n'), 'the file that is not there is named')
      .toMatch(/attached file[\s\S]*missing\.pdf|missing\.pdf/)
  }, 300_000)
})

describe('#712E: Confluence shapes GFM can carry are carried', () => {
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

describe('#712H: a Confluence emoji does not become a broken image', () => {
  it('becomes the CHARACTER, not a shortcode this product cannot render', () => {
    //substituted the alt text as `:smile:`, which was right about the broken picture and wrong
    // about the replacement: nothing here renders shortcodes, so the reader saw the colons. #712
    // ④ (user ruling) maps the fixed emoticon set to Unicode instead. The rest of this case is
    // unchanged — the picture lived in the instance being left, and must not be carried over.
    const { markdown, degraded } = confluenceHtmlToMarkdown(
      '<html><body><h1>T</h1><p>nice <img class="emoticon" src="/images/icons/emoticons/smile.png" alt="smile"/></p></body></html>',
      'T')
    expect(markdown, 'no link into the old installation').not.toContain('/images/icons/')
    expect(markdown, 'a standard character, which needs no renderer').toContain('🙂')
    expect(markdown, 'and not the shortcode').not.toContain(':smile:')
    expect(degraded, 'a mapped emoticon lost nothing, so it is not reported').toHaveLength(0)
  })

  it('leaves an ordinary image alone', () => {
    const { markdown } = confluenceHtmlToMarkdown(
      '<html><body><img src="attachments/pic.png" alt="pic"/></body></html>', 'T')
    expect(markdown).toContain('![pic](attachments/pic.png)')
  })
})

// ── #712 ③ (② / c5556-3): the input this adapter does NOT read ────────────────────────
//
// ADR-227 §6 scoped Confluence to the HTML export. c5489-3 then measured what happens when storage
// format arrives anyway: `<ac:structured-macro ac:name="jira">` matched nothing in the walk, fell to
// `default:`, and was flattened to its inner text — the string `ENG-1` alone in a paragraph, with an
// EMPTY report. The scope was never the problem. The silence was.
//
// The decision (report rather than refuse at the door) is recorded in confluence.ts: an export is one
// archive of several hundred pages, the reader did not choose which format their admin console
// produced, and refusing the archive costs them every page that would have imported cleanly.
describe('#712 ③: storage-format markup is declared, not swallowed', () => {
  it('names the macro it could not read, and keeps the text that was inside it', () => {
    const { markdown, degraded } = confluenceHtmlToMarkdown(
      '<div id="main-content"><p>Before</p><ac:structured-macro ac:name="jira"><ac:parameter ac:name="key">ENG-1</ac:parameter></ac:structured-macro><p>After</p></div>',
      'Ticket page')
    // The measured defect: `ENG-1` used to be the entire trace of the macro.
    expect(degraded.map((d) => `${d.what} ${d.detail ?? ''}`).join(' | '), 'the macro is named')
      .toMatch(/storage-format markup not converted jira/)
    expect(degraded[0]?.node, 'and attributed to the page it was on').toBe('Ticket page')
    expect(markdown, 'the text inside it is not lost').toContain('ENG-1')
    expect(markdown, 'and it is labelled where it sits').toContain('[Confluence storage format: jira]')
    expect(markdown, 'the rest of the page is untouched').toContain('Before')
    expect(markdown).toContain('After')
  })

  it('names the attachment a storage-format image points at, since the file IS in the archive', () => {
    const { degraded } = confluenceHtmlToMarkdown(
      '<div id="main-content"><ac:image ac:height="250"><ri:attachment ri:filename="pic.png"/></ac:image></div>', 'T')
    // "something was lost" versus "go and look at pic.png" — the second is actionable, and the file
    // really is sitting in the archive under that name.
    expect(degraded.map((d) => d.detail ?? '').join(' ')).toContain('pic.png')
  })

  it('reports an INLINE storage element too — a link inside a sentence never reaches the block walk', () => {
    const { markdown, degraded } = confluenceHtmlToMarkdown(
      '<div id="main-content"><p>See <ac:link><ri:page ri:content-title="Other"/>the other page</ac:link> for more.</p></div>', 'T')
    expect(degraded.length, 'the link is declared').toBeGreaterThan(0)
    expect(degraded.map((d) => d.detail ?? '').join(' ')).toMatch(/ac:link/)
    expect(markdown, 'and the sentence still reads').toContain('for more')
    expect(markdown, 'without a block marker cutting it in half').not.toContain('[Confluence storage format: ac:link]')
  })

  it('says it ONCE per page, however many times the markup repeats', () => {
    // A page migrated from an older instance can carry the same element forty times. Forty identical
    // rows say nothing the first one did not, and they bury every other finding in the report.
    const body = Array.from({ length: 12 }, () => '<p><ac:link>x</ac:link></p>').join('')
    const { degraded } = confluenceHtmlToMarkdown(`<div id="main-content">${body}</div>`, 'T')
    expect(degraded.filter((d) => (d.detail ?? '').includes('ac:link')), 'one row, not twelve').toHaveLength(1)
  })

  it('does not fire on the HTML export — the existing dialect is untouched', () => {
    // The control. A detector that matched ordinary containers would put a "not converted" line on
    // every page of every clean export, which is the recurring failure this file already documents
    // (a warning that is always present is a warning nobody reads).
    const { degraded } = confluenceHtmlToMarkdown(PAGE_HTML, 'Runbook')
    expect(degraded.map((d) => d.what).join(' '), 'nothing here is storage format')
      .not.toMatch(/storage-format/)
  })

  it('the archive still imports, and the report reaches the caller', async () => {
    // The decision under test: a page carrying `ac:` markup does not cost the reader the pages
    // beside it. Both come in; one of them is declared.
    await freshSpace()
    const report = await importArchive(
      { db, fga: fgaClient, storage: new LogicalStorageDriver(), driver: new LogicalSearchDriver() },
      zipSync({
        'index.html': strToU8('<html><body>nav</body></html>'),
        'Clean.html': strToU8('<html><body><div id="main-content"><h1>Clean</h1><p>ordinary page</p></div></body></html>'),
        'Legacy.html': strToU8('<html><body><div id="main-content"><h1>Legacy</h1><ac:structured-macro ac:name="jira"><ac:parameter ac:name="key">ENG-7</ac:parameter></ac:structured-macro></div></body></html>'),
      }),
      { tenantId: TENANT, spaceId: SPACE, userId: USER, plan: 'free' },
    )
    expect(report.pagesCreated, 'the clean page is not punished for its neighbour').toBeGreaterThanOrEqual(2)
    expect(report.degraded.some((d) => d.node === 'Legacy' && (d.detail ?? '').includes('jira')),
      `the report names it :: ${JSON.stringify(report.degraded)}`).toBe(true)
    expect(await bodyOfPage('Legacy'), 'and the value survives in the body').toContain('ENG-7')
    expect(await bodyOfPage('Clean'), 'the neighbour is intact').toContain('ordinary page')
  }, 300_000)
})
