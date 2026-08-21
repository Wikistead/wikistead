// #728 / ADR-242 §3 — the Outline dialect, measured on an archive Outline 1.9.2 actually produced.
//
// The acceptance is the ADR's own: "a real export opens the slice… a slice that cannot get one stops
// and says so rather than shipping against its own fixture". So the archive read here came out of a
// running Outline (see fixtures/outline-1.9.2/PROVENANCE.md) and is read as bytes. The shapes that
// break an adapter are the ones nobody writes by hand: a link percent-encoded ONCE MORE than the file
// name it points at, and an internal link the exporter itself left malformed.
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
import { outlineKey, outlineLinkKey, resolveOutlineRelative, splitBrokenAbsolute, looksLikeOutlineExport } from '../import/outline.js'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const USER = 'dev-user'
const FIXTURES = join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures/outline-1.9.2')

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
  const t = await privateTenant(admin, 'outline728')
  TENANT = t.id
  dispose = t.dispose
  db = await acquireTenantDb({ id: TENANT, slug: t.slug, plan: 'free', isolation: 'logical' } as never)
  const [space] = await db.sql<{ id: string }[]>`
    INSERT INTO spaces (id, tenant_id, name) VALUES (gen_random_uuid()::text, ${TENANT}, 'Outline') RETURNING id`
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

describe('#728: an Outline export is read as one', () => {
  it('the fixture is the product’s own archive, and it carries bytes', () => {
    // A pin over a fixture that silently stopped existing passes every assertion below by having
    // nothing to disagree with (#719). Counted, and the count is printed.
    const zips = readdirSync(FIXTURES).filter((f) => f.endsWith('.zip'))
    console.log(`[#728] ${zips.length} Outline archive(s) under ${FIXTURES}`)
    expect(zips.sort()).toEqual(['collection-export.zip'])
    expect(archive('collection-export.zip').byteLength).toBeGreaterThan(200)
  })

  it('is detected as outline rather than filed as a vault', () => {
    // ⚠️ The whole difficulty of this dialect. Outline writes a vault's directory shape — a `<title>.md`
    // beside a `<title>/` — so the names alone cannot tell them apart, and before this branch existed
    // these bytes came out as `obsidian`. What separates them is the LINK.
    expect(prepareImport(archive('collection-export.zip')).sourceKind).toBe('outline')
  })

  it('resolves the internal links, including the one whose title has a slash in it', async () => {
    await fresh()
    const report = await run('collection-export.zip')
    const all = await pages()
    const parent = all.find((p) => p.title === 'Handbook' && p.body.includes('Onboarding'))
    expect(parent, `parent among ${all.map((p) => p.title).join(', ')}`).toBeTruthy()

    // Both internal links point at pages in this workspace now — by id, not by the path Outline wrote.
    const hrefs = [...parent!.body.matchAll(/\]\(([^)]+)\)/g)].map((m) => m[1] as string)
    const internal = hrefs.filter((h) => h.startsWith('/p/'))
    expect(internal.length, `resolved links among ${JSON.stringify(hrefs)}`).toBe(3)

    // ⚠️ The Japanese one is the measurement that matters: its link is encoded ONE LEVEL MORE than
    // the entry it names (`%252F` in the link, `%2F` in the file name), so an importer that decodes
    // to a plain string looks for a path with a real `/` in it and finds nothing.
    expect(parent!.body).toContain('[運用](/p/')
    expect(report.deadCrossLinks, 'nothing in this archive is genuinely dead').toBe(0)
  })

  it('the external link is left alone, and the malformed absolute one is repaired', async () => {
    const all = await pages()
    const parent = all.find((p) => p.title === 'Handbook' && p.body.includes('Onboarding'))!
    // A real external link stays exactly as written.
    expect(parent.body).toContain('[external](https://example.com/p/x)')
    // ⚠️ And the third form: Outline rewrites the `/doc/…` part of an ABSOLUTE internal link in place,
    // leaving its own host glued to a relative path (`http://host./Handbook/Onboarding.md`). Reading
    // that as external — the obvious rule — hands the reader a link that goes nowhere.
    expect(parent.body, 'the host-glued form is not left in the body').not.toContain('localhost:3400.')
    expect(parent.body).toContain('[absolute](/p/')
  })

  it('keeps the duplicate-title suffix the exporter invented, rather than inventing a merge', async () => {
    const titles = (await pages()).map((p) => p.title).sort()
    // Two documents were called `Runbook`; the exporter named the second `Runbook (1).md`. That
    // suffix is not in the source data, but removing it would put two pages under one name and lose
    // which body belonged to which — the reader can rename, and cannot un-merge.
    expect(titles.filter((t) => t.startsWith('Runbook'))).toEqual(['Runbook', 'Runbook (1)'])
  })

  it('nothing is reported as dropped, because the archive carries nothing to drop', async () => {
    await fresh()
    const report = await run('collection-export.zip')
    // Measured, not assumed: an Outline Markdown export has no manifest, no front matter and no
    // per-document metadata, so a report naming losses would be naming things that were never there.
    expect(report.degraded.filter((d) => d.code.startsWith('outline'))).toEqual([])
  })
})

describe('#728: the Outline path rules, in isolation', () => {
  // These are pure and cheap, and they are where the dialect is actually wrong or right. Kept apart
  // from the walk above so a failure says WHICH rule broke rather than "the import came out wrong".
  it('decodes the LINK once and the ENTRY not at all — the two sides are escaped to different depths', () => {
    // Measured on the real archive
    // entry Handbook/Handbook/<a Japanese title> %2F <rest>.md
    // link ./Handbook/%E9%81%8B…%20%252F%20…%E6%AC%A1.md
    const entry = 'Handbook/Handbook/運用手順 %2F 日次.md'
    const link = './Handbook/%E9%81%8B%E7%94%A8%E6%89%8B%E9%A0%86%20%252F%20%E6%97%A5%E6%AC%A1.md'
    expect(outlineLinkKey(link)).toBe('./handbook/運用手順 %2f 日次')
    expect(outlineKey(entry)).toBe('handbook/handbook/運用手順 %2f 日次')
    // ⚠️ What this pins, precisely. Decoding the entry too does NOT break the fixture — both sides
    // land on the same string and still agree — so the walk above stays green under that change and
    // this assertion is the only thing standing between the escape and a real separator. What the
    // separator costs is a segment boundary the archive does not have, which `resolveOutlineRelative`
    // then walks `..` across. Measured before writing it down.
    expect(outlineLinkKey(entry), 'decoding the entry side invents a separator').toContain('順 / 日次')
    expect(outlineKey(entry), 'leaving it as written keeps the escape').toContain('順 %2f 日次')
  })

  it('resolves a link against the directory its file sits in, not the file', () => {
    // The exporter's own arithmetic leaves `./Handbook/Onboarding.md` in `Handbook/Handbook.md`.
    // Resolved from the FILE it would be `Handbook/Handbook/Handbook/Onboarding.md` — one level too
    // deep, and invisible in a flat archive.
    // The node key is `Handbook/Handbook`; the file it names sits in `Handbook`, and that is what the
    // link is relative to. Both of these are taken from the real archive.
    expect(resolveOutlineRelative('./Handbook/Onboarding.md', 'Handbook')).toBe('handbook/handbook/onboarding')
    expect(resolveOutlineRelative('../Handbook.md', 'Handbook/Handbook')).toBe('handbook/handbook')
  })

  it('declines an archive a vault would claim, even when it also holds a relative .md link', () => {
    // ⚠️ This dialect's fingerprint is a link, and a vault's directory shape is identical, so the ONE
    // thing that must not happen is claiming somebody else's archive. Measured while writing this: with
    // the wikilink guard removed, nothing in the suite went red — the guard existed and nothing asked
    // it anything. A synthetic archive is right here: what is under test is the refusal, and a real
    // Outline export cannot exhibit the shape being refused.
    const vault = ['Notes/Daily.md', 'Notes/Index.md']
    const bodies: Record<string, string> = {
      'Notes/Index.md': 'See [[Daily]] and also [the same](./Daily.md).\n',
      'Notes/Daily.md': 'Today.\n',
    }
    expect(looksLikeOutlineExport(vault, (p) => bodies[p] ?? '')).toBe(false)
    // …and without the wikilink it is genuinely ambiguous, so the relative link decides.
    const noWikilink: Record<string, string> = { ...bodies, 'Notes/Index.md': 'See [the same](./Daily.md).\n' }
    expect(looksLikeOutlineExport(vault, (p) => noWikilink[p] ?? '')).toBe(true)
  })

  it('tells a genuine external link from the host-glued one', () => {
    expect(splitBrokenAbsolute('https://example.com/p/x'), 'a real external URL').toBeNull()
    expect(splitBrokenAbsolute('https://example.com/doc/a-b1c2d3e4f5'), 'an ordinary Outline URL').toBeNull()
    expect(splitBrokenAbsolute('http://localhost:3400./Handbook/Onboarding.md')).toBe('./Handbook/Onboarding.md')
  })
})
