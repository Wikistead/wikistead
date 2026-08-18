// #747: the import fidelity table, MEASURED and then compared with the committed artifact.
//
// The ticket asked for a table of what an import can and cannot carry, and named the way to get it
// wrong: write the rows by hand. A hand-written table is correct on the day it is written and
// silently false from the next adapter change onward, and this is documentation people read while
// deciding whether to move their wiki.
//
// So this file IS the generator. Every case in `fidelity-cases.ts` becomes a page in an archive,
// the archive goes through `importArchive` — the same function the route calls — and the row's
// answer is read back out of the page that was created and out of the fidelity report. The result
// is written to `docs/generated/import-fidelity.json`, which the documentation site pulls.
//
// Running it normally COMPARES instead of writing: a change in what an adapter does turns this red
// with the diff in hand, and the person who made the change decides whether the table should follow
// (`UPDATE_IMPORT_FIDELITY=1 …`) rather than the table quietly disagreeing with the product.
//
// The second assertion is the one that keeps the table honest about LOSSES: every degradation the
// product can report must appear in the table. A new `DegradationCode` with no case is a thing the
// import can lose that the documentation does not mention, and it is red on the commit that adds it.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { zipSync, strToU8 } from 'fflate'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/tenant-db.js'
import { fgaClient, writeTuples, deleteTuples } from '@wikistead/authz'
import { importArchive, DEGRADATION_CODES } from '../import/index.js'
import { FIDELITY_SOURCES, type FidelityCase, type FidelitySource } from '../import/fidelity-cases.js'
import { LogicalSearchDriver } from '../search/index.js'
import { LogicalStorageDriver } from '../storage/index.js'
import { privateTenant } from './helpers/private-tenant.js'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const OUT = join(dirname(fileURLToPath(import.meta.url)), '../../../../docs/generated/import-fidelity.json')
const UPDATE = process.env.UPDATE_IMPORT_FIDELITY === '1'
const USER = 'dev-user'

let db: TenantDb
let dispose: () => Promise<void>
let TENANT: string

interface Row {
  id: string
  element: string
  input: string
  /** the page's title after import: Notion's id suffix coming off is itself an answer */
  title: string | null
  /** the body the reader ends up with, with generated ids masked so the table is stable */
  output: string | null
  /** what the fidelity report said about this page, by code */
  reports: { code: string; what: string; detail?: string }[]
  /** kept as written / converted into this product's own notation / something was reported */
  verdict: 'kept' | 'converted' | 'reported'
}

beforeAll(async () => {
  const t = await privateTenant(admin, 'fid747')
  TENANT = t.id
  dispose = t.dispose
  db = await acquireTenantDb({ id: TENANT, slug: t.slug, plan: 'free', isolation: 'logical' } as never)
}, 120_000)

afterAll(async () => {
  await db?.release()
  await dispose?.()
  await admin.end()
  await pool.end()
})

/** A space of its own per source, so one dialect's pages never resolve another's links. */
async function freshSpace(name: string): Promise<string> {
  const [space] = await db.sql<{ id: string }[]>`
    INSERT INTO spaces (id, tenant_id, name) VALUES (gen_random_uuid()::text, ${TENANT}, ${name}) RETURNING id`
  const id = space!.id
  await writeTuples(fgaClient, [
    { user: `user:${USER}`, relation: 'editor_member', object: `space:${id}` },
    { user: `user:${USER}`, relation: 'manager', object: `space:${id}` },
  ])
  return id
}

const bytes = (s: string): Uint8Array => Uint8Array.from([...s].map((c) => c.charCodeAt(0) & 0xff))

/** Generated ids carry no information for a reader and would churn the artifact on every run. */
const mask = (md: string): string =>
  md
    .replace(/\/p\/[0-9a-f-]{36}/g, '/p/<page-id>')
    .replace(/wks-attachment:[0-9a-f-]{36}/g, 'wks-attachment:<file-id>')
    .replace(/\n+$/, '')

async function measure(source: FidelitySource): Promise<Row[]> {
  const spaceId = await freshSpace(`fidelity ${source.id}`)
  const files: Record<string, Uint8Array> = {}
  for (const [path, text] of Object.entries(source.support)) files[path] = bytes(text)
  for (const c of source.cases) {
    files[c.path ?? source.pathFor(c)] = bytes(c.input)
    for (const [path, text] of Object.entries(c.extra ?? {})) files[path] = bytes(text)
  }

  const report = await importArchive(
    { db, fga: fgaClient, storage: new LogicalStorageDriver(), driver: new LogicalSearchDriver() },
    zipSync(files),
    { tenantId: TENANT, spaceId, userId: USER, plan: 'free' },
  )

  const pages = await db.sql<{ id: string; title: string; ydoc: Buffer }[]>`
    SELECT id, title, ydoc FROM pages WHERE tenant_id = ${TENANT} AND space_id = ${spaceId}`
  const Y = await import('yjs')
  const bodyOf = (ydoc: Buffer): string => {
    const doc = new Y.Doc()
    Y.applyUpdate(doc, new Uint8Array(ydoc))
    return doc.getText('content').toString()
  }

  return source.cases.map((c: FidelityCase): Row => {
    // A construct's degradations are filed under the name the READER would recognise, which is
    // usually the page's own title but is the file name for a `.canvas` and the database name for a
    // Notion database. The case says so when it differs; the join never guesses.
    const node = c.node ?? c.id
    // The case id is in the file name and the title is derived from it, so a page whose title starts
    // with the id is this case's page whatever the adapter did to the rest of the name.
    const page = c.producesPage === false ? undefined
      : pages.find((p) => p.title === node) ?? pages.find((p) => p.title.startsWith(node))
    if (c.producesPage !== false) expect(page, `case "${c.id}" produced a page`).toBeTruthy()
    const output = page ? mask(bodyOf(page.ydoc)) : null
    const reports = report.degraded
      .filter((d) => d.node === (page?.title ?? node))
      .map((d) => (d.detail ? { code: d.code as string, what: d.what, detail: d.detail } : { code: d.code as string, what: d.what }))
    const verdict: Row['verdict'] = reports.length ? 'reported'
      : output !== null && output.trim() === c.input.trim() ? 'kept' : 'converted'
    return { id: c.id, element: c.element, input: c.input.replace(/\n+$/, ''), title: page?.title ?? null, output, reports, verdict }
  })
}

describe('#747: the import fidelity table is measured, not written', () => {
  it('matches what the shipped import path actually does with each construct', async () => {
    const measured = {
      note: 'Generated by apps/server/src/__tests__/import-fidelity-747.test.ts — do not edit by hand.',
      sources: [] as { id: string; name: string; cases: Row[] }[],
    }
    for (const source of FIDELITY_SOURCES) {
      measured.sources.push({ id: source.id, name: source.name, cases: await measure(source) })
    }
    const serialised = `${JSON.stringify(measured, null, 2)}\n`

    if (UPDATE) {
      writeFileSync(OUT, serialised)
      return
    }
    const committed = readFileSync(OUT, 'utf8')
    // Compared as parsed objects so the diff a reader gets names the case, not a character offset.
    expect(JSON.parse(committed), 'docs/generated/import-fidelity.json is stale — rerun with UPDATE_IMPORT_FIDELITY=1')
      .toEqual(measured)
  }, 300_000)

  it('has a case for every loss the import can report', () => {
    const committed = JSON.parse(readFileSync(OUT, 'utf8')) as { sources: { cases: Row[] }[] }
    const covered = new Set(committed.sources.flatMap((s) => s.cases.flatMap((c) => c.reports.map((r) => r.code))))
    // Discovery, not a list: a new DegradationCode is something an import can lose, and a table that
    // does not mention it is a documentation gap on the day the code lands rather than whenever
    // somebody notices. `DEGRADATION_CODES` is walked, so this cannot be satisfied by editing a list.
    expect(DEGRADATION_CODES.length, 'the walk found codes to check').toBeGreaterThan(10)
    const missing = DEGRADATION_CODES.filter((code) => !covered.has(code))
    expect(missing, 'every degradation the product reports has a row in the table').toEqual([])
  })
})
