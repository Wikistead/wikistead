// #728 / ADR-242 §3 — the Docmost dialect, measured on archives Docmost 0.95.0 actually produced.
//
// The acceptance this file answers is the ADR's own: "a real export opens the slice… a slice that
// cannot get one stops and says so rather than shipping against its own fixture". So every archive
// read here came out of a running Docmost (see fixtures/docmost-0.95.0/PROVENANCE.md) and is read as
// bytes — the shapes that broke earlier adapters are the ones nobody would think to write by hand
// an entry name that is raw where its link is percent-encoded, two encoders for one page, a `/` the
// file name silently dropped, and an attachment path with an empty segment in the middle.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'
import { acquireTenantDb, type TenantDb } from '../db/tenant-db.js'
import { fgaClient, writeTuples } from '@wikistead/authz'
import { importArchive, prepareImport, type ImportReport } from '../import/index.js'
import { LogicalSearchDriver } from '../search/index.js'
import { LogicalStorageDriver } from '../storage/index.js'
import { privateTenant } from './helpers/private-tenant.js'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const USER = 'dev-user'
const FIXTURES = join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures/docmost-0.95.0')

let db: TenantDb
let dispose: () => Promise<void>
let TENANT: string
let SPACE: string

const deps = () => ({ db, fga: fgaClient, storage: new LogicalStorageDriver(), driver: new LogicalSearchDriver() })
const archive = (name: string): Uint8Array => new Uint8Array(readFileSync(join(FIXTURES, name)))
const run = (name: string): Promise<ImportReport> =>
  importArchive(deps(), archive(name), { tenantId: TENANT, spaceId: SPACE, userId: USER, plan: 'free' })

async function fresh(): Promise<void> {
  await admin`DELETE FROM pages WHERE tenant_id = ${TENANT}`
}

async function pages(): Promise<{ id: string; title: string; body: string }[]> {
  const Y = await import('yjs')
  const rows = await db.sql<{ id: string; title: string; ydoc: Buffer }[]>`
    SELECT id, title, ydoc FROM pages WHERE tenant_id = ${TENANT} ORDER BY title`
  return rows.map((r) => {
    const doc = new Y.Doc()
    Y.applyUpdate(doc, new Uint8Array(r.ydoc))
    return { id: r.id, title: r.title, body: doc.getText('content').toString() }
  })
}

beforeAll(async () => {
  const t = await privateTenant(admin, 'docmost728')
  TENANT = t.id
  dispose = t.dispose
  db = await acquireTenantDb({ id: TENANT, slug: t.slug, plan: 'free', isolation: 'logical' } as never)
  const [space] = await db.sql<{ id: string }[]>`
    INSERT INTO spaces (id, tenant_id, name) VALUES (gen_random_uuid()::text, ${TENANT}, 'Docmost') RETURNING id`
  SPACE = space!.id
  await writeTuples(fgaClient, [
    { user: `user:${USER}`, relation: 'editor_member', object: `space:${SPACE}` },
    { user: `tenant:${TENANT}`, relation: 'tenant', object: `space:${SPACE}` },
  ])
}, 180_000)

afterAll(async () => {
  await fresh().catch(() => {})
  await db?.release?.()
  await dispose?.()
  await admin.end()
})

describe('#728: a Docmost export is read as one', () => {
  it('the fixtures are the product’s own archives, and there are three of them', () => {
    // A pin over fixtures that silently stopped existing would pass every assertion below by having
    // nothing to disagree with (#719). Counted, and the count is printed.
    const zips = readdirSync(FIXTURES).filter((f) => f.endsWith('.zip'))
    console.log(`[#728] ${zips.length} Docmost archive(s) under ${FIXTURES}`)
    expect(zips.sort()).toEqual([
      'page-subtree.zip', 'space-two-attachments-same-name.zip', 'space-with-attachment.zip', 'space.zip',
    ])
    for (const z of zips) expect(archive(z).byteLength, `${z} carries bytes`).toBeGreaterThan(200)
  })

  it('is detected as docmost rather than filed as a vault', () => {
    // Before this dialect existed the same bytes came out as `obsidian`: no manifest the importer knew,
    // so the fallback claimed it — and a vault resolves `[[wikilink]]`, which Docmost never writes.
    for (const z of ['page-subtree.zip', 'space.zip', 'space-with-attachment.zip', 'space-two-attachments-same-name.zip']) {
      expect(prepareImport(archive(z)).sourceKind, z).toBe('docmost')
    }
  })

  it('takes the title from the heading, because the file name lost a character', async () => {
    await fresh()
    await run('space.zip')
    const titles = (await pages()).map((p) => p.title)
    // The page's title has a slash in it. Its entry name does not: the sanitiser DELETES the slash
    // and leaves both spaces, so a title read off the file name is a different string.
    expect(titles).toContain('運用手順 / 日次')
    expect(titles.some((t) => t.includes('運用手順  日次')), 'the file name is not the title').toBe(false)
    // And the heading is not left in the body as well, which would print the title twice.
    const jp = (await pages()).find((p) => p.title === '運用手順 / 日次')!
    expect(jp.body.startsWith('#'), 'the title heading was taken out of the body').toBe(false)
  })

  it('rewrites every internal link, including the two the encoders disagree about', async () => {
    await fresh()
    const report = await run('space.zip')
    const all = await pages()
    const handbook = all.find((p) => p.title === 'Handbook')!
    const idOf = (title: string, nth = 0) => all.filter((p) => p.title === title)[nth]!.id
    // Plain ASCII, non-ASCII (percent-encoded in the link, raw in the entry name), and the duplicate
    // title whose parentheses the link escapes and the manifest does not.
    expect(handbook.body).toContain(`(/p/${idOf('Onboarding')})`)
    expect(handbook.body).toContain(`(/p/${idOf('運用手順 / 日次')})`)
    expect(handbook.body).toContain(`(/p/${idOf('Outside The Export')})`)
    expect(handbook.body).toMatch(/\[Runbook\]\(\/p\/[0-9a-f-]{36}\)/)
    expect(handbook.body).toMatch(/\[Runbook dup\]\(\/p\/[0-9a-f-]{36}\)/)
    // Nothing shaped like the archive's own paths is left behind, and the link out of the product
    // stays exactly as it was written.
    expect(handbook.body).not.toContain('.md)')
    expect(handbook.body).toContain('(https://example.com/docs)')
    expect(report.deadCrossLinks, 'no link was counted dead').toBe(0)
    // The report ③ added for this exact archive now has nothing to say, and that is how the two halves
    // meet: `sourcePageLinkKept` was the placeholder for "the dialect does not exist yet".
    expect(report.degraded.filter((d) => d.code === 'sourcePageLinkKept')).toEqual([])
  })

  it('resolves a link written as the product’s own URL when that page came too', async () => {
    await fresh()
    const report = await run('page-subtree.zip')
    const all = await pages()
    // The subtree export leaves `Outside The Export` behind, and Docmost rewrites the link to it as an
    // absolute URL at its own host. That is not a dead link — it points at a page that was never in
    // the archive — so it is left alone and NOT counted.
    const handbook = all.find((p) => p.title === 'Handbook')!
    expect(handbook.body).toMatch(/\(http:\/\/localhost:3399\/s\/general\/p\/[0-9A-Za-z]+\)/)
    expect(report.deadCrossLinks, 'a page outside the export is not a dead link').toBe(0)
    // …while the four that DID come are addressed.
    expect(handbook.body.match(/\(\/p\/[0-9a-f-]{36}\)/g)?.length).toBe(4)
  })

  it('finds the attachment whose entry name carries an empty path segment', async () => {
    await fresh()
    const report = await run('space-with-attachment.zip')
    // `Handbook//files/<id>/<name>` — the folder name and a path that already starts with `/`,
    // concatenated. Unzipping to a disk hides it; matching entry names as strings does not.
    expect(report.attachmentsImported, 'the image came in').toBe(1)
    expect(report.attachmentsSkipped).toEqual([])
    const onboarding = (await pages()).find((p) => p.title === 'Onboarding')!
    expect(onboarding.body).toMatch(/!\[[^\]]*\]\(wks-attachment:[0-9a-f-]{36}\)/)
    expect(onboarding.body).not.toContain('files/')
  })

  it('gives each page ITS OWN file when two attachments share a name', async () => {
    // Docmost stores an attachment under its own id, so two pages can hold one file NAME and mean two
    // different files. The generic resolution falls back to the FILE NAME when the path does not match
    // an entry, and the paths never matched here — the body writes `files/<id>/<name>` relative to the
    // page's folder while the entry is `<folder>//files/<id>/<name>`. So both pages resolved to
    // whichever file was collected first: the picture on one page silently became the other's.
    await fresh()
    const report = await run('space-two-attachments-same-name.zip')
    expect(report.attachmentsImported, 'both files came in').toBe(2)
    const all = await pages()
    const idIn = (title: string) =>
      /wks-attachment:([0-9a-f-]{36})/.exec(all.find((p) => p.title === title)!.body)?.[1] ?? null
    const onboarding = idIn('Onboarding')
    const runbook = idIn('Runbook')
    expect(onboarding, 'Onboarding shows an attachment').toBeTruthy()
    expect(runbook, 'Runbook shows an attachment').toBeTruthy()
    expect(runbook, 'the two pages do not share one file').not.toBe(onboarding)
  })
})
