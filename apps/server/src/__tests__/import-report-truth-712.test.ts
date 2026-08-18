// #712 — four defects found by importing real-shaped exports through the screen and then
// comparing FOUR things: the body, the report, the attachment rows, and what the reader sees.
//
// They share a shape the earlier pins could not catch, because each of those checked one surface:
//
//   ① a file arrives as an attachment that is not content at all (`.obsidian/` config)
//   ② the report names a degradation that did not happen (a Notion cross-link that resolves)
//   ③ the body is right and the attachment ROW points at the wrong page (deleting it takes the files)
//   ④ the body carries `:smile:`, which nothing in this product renders
//
// ② and ③ are the interesting ones. A report that invents a loss is worse than one that stays quiet:
// somebody migrating goes looking for a broken link that was never broken, and stops trusting the
// lines that ARE true. And an attachment row is invisible until the day a page is deleted, so this
// asserts the owner explicitly rather than trusting that the rendered body looked fine.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { zipSync, strToU8 } from 'fflate'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/tenant-db.js'
import { fgaClient, writeTuples, deleteTuples } from '@wikistead/authz'
import { importArchive, type ImportReport } from '../import/index.js'
import { confluenceHtmlToMarkdown } from '../import/confluence.js'
import { LogicalSearchDriver } from '../search/index.js'
import { LogicalStorageDriver } from '../storage/index.js'
import { privateTenant } from './helpers/private-tenant.js'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const USER = 'dev-user'

let db: TenantDb
let dispose: () => Promise<void>
let TENANT: string
let SPACE: string

const deps = () => ({ db, fga: fgaClient, storage: new LogicalStorageDriver(), driver: new LogicalSearchDriver() })
const run = (files: Record<string, Uint8Array>): Promise<ImportReport> =>
  importArchive(deps(), zipSync(files), { tenantId: TENANT, spaceId: SPACE, userId: USER, plan: 'free' })

async function fresh(): Promise<void> {
  await admin`DELETE FROM pages WHERE tenant_id = ${TENANT}`
}

async function bodyOf(title: string): Promise<string> {
  const Y = await import('yjs')
  const [row] = await db.sql<{ ydoc: Buffer }[]>`
    SELECT ydoc FROM pages WHERE tenant_id = ${TENANT} AND title = ${title}`
  expect(row, `page "${title}" was created`).toBeTruthy()
  const doc = new Y.Doc()
  Y.applyUpdate(doc, new Uint8Array(row!.ydoc))
  return doc.getText('content').toString()
}

/** every attachment row with the TITLE of the page it hangs on — the thing a delete follows */
async function attachmentOwners(): Promise<{ name: string; page: string }[]> {
  return admin<{ name: string; page: string }[]>`
    SELECT a.filename AS name, p.title AS page
    FROM attachments a JOIN pages p ON p.id = a.page_id
    WHERE a.tenant_id = ${TENANT} ORDER BY a.filename`
}

beforeAll(async () => {
  const t = await privateTenant(admin, 'imptruth712')
  TENANT = t.id
  dispose = t.dispose
  db = await acquireTenantDb({ id: TENANT, slug: t.slug, plan: 'free', isolation: 'logical' } as never)
  const [space] = await db.sql<{ id: string }[]>`
    INSERT INTO spaces (id, tenant_id, name) VALUES (gen_random_uuid()::text, ${TENANT}, 'Report truth') RETURNING id`
  SPACE = space!.id
  await writeTuples(fgaClient, [
    { user: `user:${USER}`, relation: 'editor_member', object: `space:${SPACE}` },
    { user: `tenant:${TENANT}`, relation: 'tenant', object: `space:${SPACE}` },
  ])
}, 180_000)

afterAll(async () => {
  await deleteTuples(fgaClient, [
    { user: `user:${USER}`, relation: 'editor_member', object: `space:${SPACE}` },
    { user: `tenant:${TENANT}`, relation: 'tenant', object: `space:${SPACE}` },
  ]).catch(() => {})
  // The tenant connection has to go back before the pool closes, or teardown hangs on a checked-out
  // client and the file fails with a hook timeout while every case inside it passed.
  await db?.release()
  await dispose?.()
  await admin.end()
  await pool.end()
})

describe('#712 ①: a vault brings its notes, not its settings', () => {
  it('ignores .obsidian/ for ATTACHMENTS too, not just for pages', async () => {
    await fresh()
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7, 7, 7])
    const report = await run({
      'Home.md': strToU8('# Home\n\n![[diagram.png]]\n'),
      'attachments/diagram.png': png,
      // What a real vault carries. `.obsidian/` is that tool's own state: window layout, themes,
      // plugin settings. The docs already said it is ignored, and pages were — attachments were not.
      '.obsidian/app.json': strToU8('{"promptDelete":false}'),
      '.obsidian/workspace.json': strToU8('{"main":{}}'),
      '.obsidian/themes/Minimal/theme.css': strToU8('body{}'),
      '.trash/Deleted note.md': strToU8('# Deleted\n'),
    })
    expect(report.attachmentsImported, 'the picture, and nothing the editor keeps for itself').toBe(1)
    const owners = await attachmentOwners()
    expect(owners.map((o) => o.name)).toEqual(['diagram.png'])
    // …and the count the report shows is the same number, since that is what the reader compares
    // against the folder they uploaded.
    expect(owners).toHaveLength(report.attachmentsImported)
  }, 300_000)
})

describe('#712 ②: the report does not invent a loss', () => {
  it('a Notion cross-link that resolves is not reported as a missing attachment', async () => {
    await fresh()
    const hexA = '1b2c3d4e5f60718293a4b5c6d7e8f902'
    const hexB = '2c3d4e5f60718293a4b5c6d7e8f90213'
    const report = await run({
      [`Home ${hexA}.md`]: strToU8(`# Home\n\nRead the [Roadmap](Roadmap%20${hexB}.md).\n`),
      [`Roadmap ${hexB}.md`]: strToU8('# Roadmap\n\nQ3 things.\n'),
    })
    // It resolves — that is the point. The body proves the link was never lost.
    expect(await bodyOf('Home'), 'the cross-link became a product link').toMatch(/\/p\/[0-9a-f-]{8}/)
    // …so nothing may claim otherwise. Asserted as an ABSENCE, which is the assertion nobody writes:
    // the earlier pins all checked that something appears.
    const invented = report.degraded.filter((d) => d.code === 'attachmentLinkMissing')
    expect(invented, `nothing was lost, so nothing is named :: ${JSON.stringify(report.degraded)}`).toHaveLength(0)
  }, 300_000)

  it('a Notion link that really is dead is counted ONCE, by the pass that knows', async () => {
    await fresh()
    const hexA = '3d4e5f60718293a4b5c6d7e8f9021324'
    const report = await run({
      [`Home ${hexA}.md`]: strToU8('# Home\n\nSee [Archive](Archive%2000000000000000000000000000000000.md).\n'),
    })
    expect(report.deadCrossLinks, 'the dialect that knows the archive counts it').toBeGreaterThan(0)
    // The double report: it used to appear here as well, wearing the wrong name ("an attached file").
    expect(report.degraded.filter((d) => d.code === 'attachmentLinkMissing'),
      `counted once, not twice :: ${JSON.stringify(report.degraded)}`).toHaveLength(0)
  }, 300_000)

  it('…and a genuinely missing FILE is still reported, so the fix did not silence the real case', async () => {
    // The control. Excluding page-shaped extensions must not excuse a link to a file the archive
    // does not carry — that is the case this report exists for.
    await fresh()
    const report = await run({
      'Home.md': strToU8('# Home\n\nHere is the [paper](attachments/paper.pdf).\n'),
    })
    expect(report.degraded.map((d) => d.code), `the missing file is named :: ${JSON.stringify(report.degraded)}`)
      .toContain('attachmentLinkMissing')
  }, 300_000)
})

describe('#712 ③: an attachment belongs to the page that uses it', () => {
  it('hangs a shared file on the referencing page, not on whichever page sorted first', async () => {
    await fresh()
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
    const pdf = strToU8('%PDF-1.4 not really')
    const report = await run({
      // `AAA` sorts first and references NOTHING. Before the fix both files hung on it, so deleting an
      // index page took every image in the space with it — invisible in the body, which was correct.
      'AAA.html': strToU8('<html><body><div id="main-content"><h1>AAA</h1><p>no picture here</p></div></body></html>'),
      'Runbook.html': strToU8('<html><body><div id="main-content"><h1>Runbook</h1>'
        + '<p><img src="attachments/pic.png" alt="pic"></p>'
        + '<p><a href="attachments/paper.pdf">paper</a></p></div></body></html>'),
      'attachments/pic.png': png,
      'attachments/paper.pdf': pdf,
    })
    expect(report.attachmentsImported).toBe(2)
    const owners = await attachmentOwners()
    expect(owners, `both files hang on the page that names them :: ${JSON.stringify(owners)}`).toEqual([
      { name: 'paper.pdf', page: 'Runbook' },
      { name: 'pic.png', page: 'Runbook' },
    ])
    // And the body is still right — the earlier fix is not undone by this one.
    const body = await bodyOf('Runbook')
    expect(body, 'the image resolves').toMatch(/wks-attachment:/)
    expect(body, 'no archive-relative path survives').not.toContain('attachments/pic.png')
  }, 300_000)

  it('a file nobody references still arrives, rather than being dropped', async () => {
    // The other direction. Silently dropping an unreferenced file would be this feature's own sin,
    // and a vault legitimately holds images that no note embeds yet.
    await fresh()
    const report = await run({
      'Home.md': strToU8('# Home\n\nNothing embedded.\n'),
      'attachments/orphan.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9, 9]),
    })
    expect(report.attachmentsImported).toBe(1)
    expect((await attachmentOwners()).map((o) => o.name)).toEqual(['orphan.png'])
  }, 300_000)
})

describe('#712 ④: a Confluence emoticon becomes the character', () => {
  it('maps the fixed set to Unicode and says nothing, because nothing was lost', () => {
    const { markdown, degraded } = confluenceHtmlToMarkdown(
      '<div id="main-content"><p>nice <img class="emoticon" src="/images/icons/emoticons/smile.png" alt="smile"/>'
      + ' <img class="emoticon" src="/images/icons/emoticons/check.png" alt="tick"/></p></div>', 'T')
    expect(markdown, 'the character itself').toContain('🙂')
    expect(markdown).toContain('✅')
    // `:smile:` is what produced, and this product has no shortcode pass — the reader saw the
    // colons. Asserted directly so the old behaviour cannot come back as "close enough".
    expect(markdown, 'no shortcode this product cannot render').not.toContain(':smile:')
    expect(markdown, 'no link into the instance being left').not.toContain('/images/icons/')
    expect(degraded, `a mapped emoticon lost nothing :: ${JSON.stringify(degraded)}`).toHaveLength(0)
  })

  it('an emoticon outside the table keeps the honest fallback: the name, and a report', () => {
    // The half of that was right. An unknown name is a real loss, and it says so.
    const { markdown, degraded } = confluenceHtmlToMarkdown(
      '<div id="main-content"><p><img class="emoticon" src="/images/icons/emoticons/party-parrot.png" alt="party-parrot"/></p></div>', 'T')
    expect(markdown).toContain(':party-parrot:')
    expect(degraded.map((d) => d.code)).toContain('emojiReplacedByName')
  })

  it('an ordinary image is not touched by the emoticon rule', () => {
    const { markdown, degraded } = confluenceHtmlToMarkdown(
      '<div id="main-content"><img src="attachments/pic.png" alt="tick"/></div>', 'T')
    // Same alt text, different path: the rule is about where the picture lives, not what it is called.
    expect(markdown).toContain('![tick](attachments/pic.png)')
    expect(degraded).toHaveLength(0)
  })
})
