// #797: no fixture may claim a row that only ONE tenant can hold, inside a tenant everybody shares.
//
// What happened: `ce-saml-entitlement-693` (this package) and `saml-cli-composition-693` (the EE
// package) both wrote an enabled `tenant_saml` row for `tenant_acme`. That table holds ONE row per
// tenant and turbo runs the two packages in parallel, so the two fixtures could not both exist — one
// run in four died on `tenant_saml_tenant_unique`, and the file that died read as a product bug.
//
// The seeded tenant made it worse than flaky. `prune-test-tenants` deliberately KEEPS the seeded
// pair, so a run killed between the INSERT and its `afterAll` left a row nothing would ever collect,
// and every run after it failed the same INSERT until somebody cleared the table by hand.
//
// Both fixtures now own a tenant named after their file, which is outside the KEEP list and so gets
// reclaimed with anything a killed run left inside it. This pin is the part that keeps it true: the
// same shape is easy to write again, and the collision only shows up under parallelism.
//
// It is a DISCOVERY pin, not a list of the three files that were wrong — the next one will have a
// different name. Every input is derived: the tables from the LIVE schema (the constraint set is
// what actually decides who can coexist, and it moves — `tenant_oidc` was per-tenant-unique until
// #554 made connections plural), and the seeded tenants from the prune script's own KEEP list.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
// #178: where EE source lives is one file's business — this sweep must not grow a sixth hard-coded
// copy of it. `null` means a CE-only tree, where the EE half of the family simply is not present.
// @ts-expect-error — repo-root script module, no types (#621 convention)
import { eeServerSourceRoot } from '../../../../scripts/ee-source-root.mjs'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const root = resolve(import.meta.dirname, '../../../..')

/** Every suite that writes to this database: the two CE packages, plus EE when this tree has it. */
function suiteDirs(): string[] {
  const ee = eeServerSourceRoot(root) as string | null
  return [
    resolve(root, 'apps/server/src/__tests__'),
    resolve(root, 'apps/collab/src/__tests__'),
    ...(ee ? [join(ee, '__tests__')] : []),
  ]
}

function testFiles(): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    if (!existsSync(dir)) return
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.test.ts')) out.push(p)
    }
  }
  for (const d of suiteDirs()) walk(d)
  return out
}

/**
 * Tables where a tenant may hold at most ONE row — asked of the running database rather than listed
 * here, because a list would be right on the day it was written and wrong the day a constraint moves.
 */
async function singleRowPerTenantTables(): Promise<string[]> {
  const rows = await admin<{ tbl: string; cols: string }[]>`
    SELECT c.conrelid::regclass::text AS tbl,
           (SELECT string_agg(a.attname, ',' ORDER BY a.attname)
              FROM unnest(c.conkey) k JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k) AS cols
      FROM pg_constraint c
     WHERE c.contype IN ('p', 'u')`
  return [...new Set(rows.filter((r) => r.cols === 'tenant_id').map((r) => r.tbl))].sort()
}

/** The tenants `prune-test-tenants` refuses to collect, read from the script that decides it. */
function seededTenantIds(): string[] {
  const src = readFileSync(resolve(root, 'infra/db/prune-test-tenants.ts'), 'utf8')
  const m = /const KEEP = \[([^\]]*)\]/.exec(src)
  if (!m) throw new Error('could not read the KEEP list out of infra/db/prune-test-tenants.ts')
  return [...m[1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!)
}

/**
 * CODE only. A file that explains which shared tenant it USED TO write still contains the name, and a
 * sweep that reads prose would report the very fixtures that were just fixed — so comments come off
 * before anything is matched.
 *
 * A whole-file scanner rather than a line-by-line one, because both traps here cross lines or hide
 * inside quotes: these fixtures hold multi-line SQL in template literals (a line-local quote count
 * calls the second line of one "outside a string"), and prose like `/public/*` in a `//` comment
 * opens a block comment that then eats the rest of the file. Deciding what a `/` means requires
 * knowing what is already open, which is what this tracks. The caller checks the result still looks
 * like a test file, because a stripper that eats a file reports every file as clean.
 */
function stripComments(source: string): string {
  let out = ''
  let i = 0
  let quote: string | null = null // ' " or ` while inside a string
  while (i < source.length) {
    const c = source[i]!
    const next = source[i + 1]
    if (quote) {
      if (c === '\\') { out += '  '; i += 2; continue } // an escaped anything is never a terminator
      if (c === quote) quote = null
      out += c; i++; continue
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; out += c; i++; continue }
    if (c === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i++
      continue
    }
    if (c === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2)
      const stop = end < 0 ? source.length : end + 2
      // Keep the newlines so line numbers and line-anchored matches survive the strip.
      out += source.slice(i, stop).replace(/[^\n]/g, ' ')
      i = stop; continue
    }
    out += c; i++
  }
  return out
}

/**
 * An INSERT with no `ON CONFLICT` claims the row outright: two of them cannot coexist. One that
 * upserts is a different (milder) problem — the neighbour's VALUE changes rather than the run dying —
 * and it is not what this ticket is about.
 */
function bareInsertTables(source: string, tables: string[]): string[] {
  const hit: string[] = []
  for (const t of tables) {
    for (const m of source.matchAll(new RegExp(String.raw`INSERT INTO\s+${t}\b`, 'g'))) {
      const rest = source.slice(m.index!)
      const end = rest.indexOf('`') // the end of the tagged-template statement
      if (!/ON CONFLICT/.test(rest.slice(0, end > 0 ? end : 400))) { hit.push(t); break }
    }
  }
  return hit
}

/**
 * Does this file clear the row before claiming it? The sequence that survives a killed run is DELETE
 * my tenant's row, then INSERT — and the DELETE has to be scoped to a tenant, because an unscoped one
 * in a shared stack takes a neighbour's fixture with it.
 *
 * Asked of every bare-INSERTing file, not only the ones whose tenant is stable across runs. A file
 * that mints a tenant per run cannot collide with its own residue today, so the DELETE is a no-op
 * there — and it is what keeps the file green on the day somebody gives it a fixed slug, which is a
 * one-word edit nothing else would flag.
 */
function clearsBeforeClaiming(source: string, table: string): boolean {
  return new RegExp(String.raw`DELETE FROM\s+${table}\b[^\`]*tenant_id`).test(source)
}

/** Does this file resolve one of the seeded tenants at all — by id, or by the slug it is looked up with? */
function namesASeededTenant(source: string, seeded: string[]): string[] {
  const slugs = seeded.map((id) => id.replace(/^tenant_/, ''))
  return [...seeded, ...slugs.flatMap((s) => [`'${s}'`, `"${s}"`])].filter((needle) => source.includes(needle))
}

afterAll(async () => { await admin.end() })

let tables: string[] = []
let seeded: string[] = []
let files: string[] = []
beforeAll(async () => {
  tables = await singleRowPerTenantTables()
  seeded = seededTenantIds()
  files = testFiles()
}, 60_000)

describe('#797: single-row-per-tenant fixtures stay out of the seeded tenants', () => {
  it('the inputs are real — a schema with such tables, a KEEP list, and suites to read', () => {
    // Every one of these silently empty would make the sweep below pass having judged nothing, which
    // is the failure mode this whole family of pins keeps producing (#819's definitionEmpty).
    expect(tables.length, 'no table restricts a tenant to one row — did the query stop matching?').toBeGreaterThan(0)
    expect(seeded.length, 'the prune script named no tenant it keeps').toBeGreaterThan(0)
    expect(files.length, 'no test files found to sweep').toBeGreaterThan(0)
  })

  it('no test file bare-INSERTs one of those rows while naming a seeded tenant', () => {
    const writers: string[] = []
    const offenders: string[] = []
    const eaten: string[] = []
    for (const f of files) {
      const raw = readFileSync(f, 'utf8')
      const src = stripComments(raw)
      // A comment stripper that swallows a file turns every file into a clean one, silently. Measured
      // by what must SURVIVE rather than by how much did: several of these files are four-fifths
      // prose by design, so a size ratio flags the best-documented pins and misses a real bug.
      if (!/^import /m.test(src) || !/\b(describe|it|test)\(/.test(src)) eaten.push(f.slice(root.length + 1))
      const bare = bareInsertTables(src, tables)
      if (bare.length === 0) continue
      const rel = f.slice(root.length + 1)
      writers.push(rel)
      const named = namesASeededTenant(src, seeded)
      if (named.length > 0) offenders.push(`${rel} → ${bare.join(', ')} (names ${named.join(', ')})`)
    }
    expect(eaten, 'the comment stripper left these files without imports or cases — it ate the code').toEqual([])
    // The sweep has to have SEEN the shape it forbids, or "no offenders" means the matcher broke.
    expect(writers.length, `no fixture bare-INSERTs any of: ${tables.join(', ')}`).toBeGreaterThan(0)
    expect(offenders, `${writers.length} fixture(s) claim a single-row-per-tenant row; these do it in a shared tenant`).toEqual([])
  })

  it('and each of them clears its own tenant first, so a killed run cannot poison the next', () => {
    // The other half of #797, and the half `fixture-residue-797` cannot measure: that file proves the
    // SEQUENCE survives residue, but it proves it against its own copy of the sequence — remove the
    // DELETE from a shipped fixture and those cases stay green. Deleting-then-claiming is a property
    // of every writer, so it is asserted over the same swept set as the rule above.
    const writers: string[] = []
    const unguarded: string[] = []
    for (const f of files) {
      const src = stripComments(readFileSync(f, 'utf8'))
      const bare = bareInsertTables(src, tables)
      if (bare.length === 0) continue
      const rel = f.slice(root.length + 1)
      writers.push(rel)
      for (const t of bare) if (!clearsBeforeClaiming(src, t)) unguarded.push(`${rel} → ${t}`)
    }
    expect(writers.length, 'nothing bare-INSERTs a single-row-per-tenant table — the matcher broke').toBeGreaterThan(0)
    expect(unguarded, 'these claim a one-per-tenant row without clearing their own first (#797)').toEqual([])
  })
})
