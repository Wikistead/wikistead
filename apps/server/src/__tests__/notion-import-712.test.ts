// #712 / ADR-227 §5 — the Notion dialect, measured on the shape Notion actually exports.
//
// A real "Markdown & CSV" export looks nothing like a tidy fixture: every filename carries a 32-hex
// id, child pages live in a directory named after the parent (id and all), a database is a `.csv`
// sitting beside a directory of one-file-per-row, and internal links are URL-encoded relative paths
// to those same filenames. Each of those details broke something the first time it was measured,
// which is why the fixture reproduces them rather than an idealised tree.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { zipSync, strToU8 } from 'fflate'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/tenant-db.js'
import { fgaClient, writeTuples, deleteTuples } from '@wikistead/authz'
import { importArchive } from '../import/index.js'
import { splitNotionName, looksLikeNotionExport, parseCsv, csvToMarkdownTable, rewriteNotionLinks } from '../import/notion.js'
import { LogicalSearchDriver } from '../search/index.js'
import { LogicalStorageDriver } from '../storage/index.js'
import { privateTenant } from './helpers/private-tenant.js'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)

const HANDBOOK = '1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d'
const ROADMAP = '9f8e7d6c5b4a39281706f5e4d3c2b1a0'
const TASKS_DB = 'abcdef0123456789abcdef0123456789'

// The export, written the way Notion writes one.
const EXPORT: Record<string, Uint8Array> = {
  [`Team handbook ${HANDBOOK}.md`]: strToU8([
    '# Team handbook',
    '',
    `See the [Roadmap](Roadmap%20${ROADMAP}.md) for what is next.`,
    `Also on the web: [same page](https://www.notion.so/Roadmap-${ROADMAP})`,
    '[An external link](https://example.com/docs) stays put.',
    '[A page we did not export](Archive%2000000000000000000000000000000000.md) stays put too.',
    '',
  ].join('\n')),
  [`Roadmap ${ROADMAP}.md`]: strToU8('# Roadmap\n\nShip the importer.\n'),
  // A database: the CSV plus one page per row, in a directory named after it.
  [`Tasks ${TASKS_DB}.csv`]: strToU8('Name,Status,Notes\nWrite adapter,Done,"Handles ""quotes"", commas"\nShip it,In progress,\n'),
  [`Tasks ${TASKS_DB}/Write adapter 1111111111111111111111111111aaaa.md`]: strToU8('# Write adapter\n\nRow page body.\n'),
}

let db: TenantDb
let dispose: () => Promise<void>
let TENANT: string
let SPACE: string
const USER = 'dev-user'

beforeAll(async () => {
  const t = await privateTenant(admin, 'notion712')
  TENANT = t.id
  dispose = t.dispose
  db = await acquireTenantDb({ id: TENANT, slug: t.slug, plan: 'free', isolation: 'logical' } as never)
  const [space] = await db.sql<{ id: string }[]>`
    INSERT INTO spaces (id, tenant_id, name) VALUES (gen_random_uuid()::text, ${TENANT}, 'Notion target') RETURNING id`
  SPACE = space!.id
  // A run that died before afterAll leaves pages behind, and the body assertions would then read the
  // previous import (measured on the Obsidian slice — it looked exactly like a rewriting bug).
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

describe('#712: a Notion export imports through the shipped path', () => {
  it('strips the filename ids from titles, resolves both link shapes, and reports the database degrade', async () => {
    const report = await importArchive(
      { db, fga: fgaClient, storage: new LogicalStorageDriver(), driver: new LogicalSearchDriver() },
      zipSync(EXPORT),
      { tenantId: TENANT, spaceId: SPACE, userId: USER, plan: 'free' },
    )

    const rows = await db.sql<{ id: string; title: string; ydoc: Buffer }[]>`
      SELECT id, title, ydoc FROM pages WHERE tenant_id = ${TENANT}`
    const titles = rows.map((r) => r.title).sort()

    // The 32-hex suffix is noise in a title — the reader sees the page's name.
    expect(titles, 'no title carries an export id').toEqual(
      expect.arrayContaining(['Team handbook', 'Roadmap', 'Tasks', 'Write adapter']),
    )
    expect(titles.some((t) => /[0-9a-f]{32}/i.test(t)), 'no raw id leaked into a title').toBe(false)

    const bodyOf = async (title: string) => {
      const Y = await import('yjs')
      const row = rows.find((r) => r.title === title)!
      const doc = new Y.Doc()
      Y.applyUpdate(doc, new Uint8Array(row.ydoc))
      return doc.getText('content').toString()
    }
    const idOf = (title: string) => rows.find((r) => r.title === title)!.id

    const handbook = await bodyOf('Team handbook')
    // Both link shapes Notion emits resolve to the SAME imported page.
    expect(handbook, 'the relative .md link resolved').toContain(`[Roadmap](/p/${idOf('Roadmap')})`)
    expect(handbook, 'the notion.so URL resolved as well').toContain(`[same page](/p/${idOf('Roadmap')})`)
    // …and the two kinds of link that must NOT be touched are untouched.
    expect(handbook, 'an external link is left alone').toContain('(https://example.com/docs)')
    expect(handbook, 'a link to something outside the export keeps its text').toContain('Archive%2000000000000000000000000000000000.md')
    expect(report.deadCrossLinks, 'and that one is counted').toBeGreaterThan(0)

    // The database became a page with a table, and the row page is a child of nothing else.
    const tasks = await bodyOf('Tasks')
    expect(tasks, 'header row').toContain('| Name | Status | Notes |')
    expect(tasks, 'quoted field with an embedded comma and quotes survived').toContain('Handles "quotes", commas')
    expect(report.degraded.map((d) => d.what), 'the database degrade is named')
      .toContain('database became a page with a table')

    expect(report.published, 'import never publishes').toBe(0)
  }, 180_000)
})

describe('#712: the Notion rules, as functions', () => {
  it('splits a filename into title and id, and leaves an ordinary name alone', () => {
    expect(splitNotionName(`Team handbook ${HANDBOOK}`)).toEqual({ title: 'Team handbook', hex: HANDBOOK })
    expect(splitNotionName('Just a note')).toEqual({ title: 'Just a note', hex: null })
  })

  it('detects the export by its own fingerprint, and does not fire on a plain folder', () => {
    expect(looksLikeNotionExport([`Roadmap ${ROADMAP}.md`])).toBe(true)
    expect(looksLikeNotionExport(['Home.md', 'Projects/Roadmap.md']), 'a vault is not a Notion export').toBe(false)
  })

  it('reads RFC-4180 quoting the way Notion writes it', () => {
    const rows = parseCsv('A,B\n"has ""quotes"", and a comma",plain\n')
    expect(rows).toEqual([['A', 'B'], ['has "quotes", and a comma', 'plain']])
  })

  it('escapes a pipe so one cell cannot split the row', () => {
    const md = csvToMarkdownTable([['A'], ['x | y']])
    expect(md.split('\n')[2]).toBe('| x \\| y |')
  })

  it('never rewrites a link it cannot resolve, and counts it instead', () => {
    const r = rewriteNotionLinks(`[x](Gone%20${'0'.repeat(32)}.md)`, new Map())
    expect(r.markdown).toContain(`Gone%20${'0'.repeat(32)}.md`)
    expect(r.deadLinks).toBe(1)
  })
})
