// #728 / ADR-242 decision 3 (user ruling): before adding either dialect, stop the misreading
// that is live TODAY. A Docmost or Outline markdown export carries no manifest and no fingerprint the
// importer knows, so `prepareImport` files it as a vault — and a vault resolves `[[wikilink]]`, which
// neither product writes. Docmost links its pages by RELATIVE FILE PATH, Outline by `/doc/<id>`.
// Neither shape resolves, and neither is reported: the vault reader lost nothing it knows about.
//
// So the reader gets a clean-looking import whose internal links all point nowhere. That is the exact
// failure ADR-227 exists to prevent, and the report is where it has to be said.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { zipSync, strToU8 } from 'fflate'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/tenant-db.js'
import { fgaClient, writeTuples, deleteTuples } from '@wikistead/authz'
import { importArchive, type ImportReport } from '../import/index.js'
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

beforeAll(async () => {
  const t = await privateTenant(admin, 'misdetect728')
  TENANT = t.id
  dispose = t.dispose
  db = await acquireTenantDb({ id: TENANT, slug: t.slug, plan: 'free', isolation: 'logical' } as never)
  const [space] = await db.sql<{ id: string }[]>`
    INSERT INTO spaces (id, tenant_id, name) VALUES (gen_random_uuid()::text, ${TENANT}, 'Misdetect') RETURNING id`
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
  await db?.release()
  await dispose?.()
  await admin.end()
  await pool.end()
})

describe('#728 ADR-242 §3: an unreadable page link is said out loud', () => {
  // Docmost's exporter builds zip paths with `encodeURIComponent(safeTitle)` and rewrites internal
  // links to `path.relative(...)` of those paths, so the body links a percent-encoded relative path.
  //
  // MEASURED before the fix, through this same route: the body kept `(Handbook/Onboarding.md)`,
  // `deadCrossLinks` was 0, and `degraded[]` never mentioned it. Nothing anywhere said that every
  // internal link in the archive had stopped pointing at anything.
  // ⚠️ REWRITTEN by the Docmost dialect (#728 slice ①, same ticket). The original assertion here was
  // that these two links are REPORTED and left alone — which is what this slice promised while the
  // dialect did not exist, and it said so in as many words: "if a later slice DOES rewrite them, the
  // link is gone from the body and this report stops firing on its own — it reads the finished text."
  // That is now measured rather than predicted. The report's own guarantee is kept below, on the
  // archive that still has nobody to resolve it.
  it('resolves a Docmost-shaped page link now that the dialect exists', async () => {
    await fresh()
    const report = await run({
      'docmost-metadata.json': strToU8('{"source":"docmost","version":"0.1"}'),
      'Handbook.md': strToU8('# Handbook\n\nStart with [Onboarding](Handbook/Onboarding.md).\n'),
      'Handbook/Onboarding.md': strToU8('# Onboarding\n\nBack to [Handbook](../Handbook.md).\n'),
    })
    expect(report.degraded.filter((d) => d.code === 'sourcePageLinkKept'), 'nothing left to report').toEqual([])
    expect(await bodyOf('Handbook')).toMatch(/\(\/p\/[0-9a-f-]{36}\)/)
    expect(await bodyOf('Onboarding')).toMatch(/\(\/p\/[0-9a-f-]{36}\)/)
    // Still not counted as dead: both targets came in with the archive, and now they are addressed.
    expect(report.deadCrossLinks).toBe(0)
  }, 300_000)

  it('still says a Docmost-shaped link out loud when no dialect claims the archive', async () => {
    // The guarantee this file was written for, on the archive it now applies to: the SAME link shape
    // in an archive with no manifest is read as a vault (nothing else claims it), nothing resolves the
    // path, and the silence would be back if this were only a Docmost-detection feature. Somebody who
    // re-zips their export without the manifest is exactly that case.
    await fresh()
    const report = await run({
      'Handbook.md': strToU8('# Handbook\n\nStart with [Onboarding](Handbook/Onboarding.md).\n'),
      'Handbook/Onboarding.md': strToU8('# Onboarding\n\nBack to [Handbook](../Handbook.md).\n'),
    })
    const kept = report.degraded.filter((d) => d.code === 'sourcePageLinkKept')
    expect(kept.map((d) => `${d.node}: ${d.params?.target}`).sort()).toEqual([
      'Handbook: Handbook/Onboarding.md',
      'Onboarding: ../Handbook.md',
    ])
    expect(await bodyOf('Handbook')).toContain('(Handbook/Onboarding.md)')
    expect(report.deadCrossLinks).toBe(0)
  }, 300_000)

  it('names an Outline document link, which nothing else in a Markdown export writes', async () => {
    await fresh()
    const report = await run({
      'Engineering/Runbook.md': strToU8('# Runbook\n\nSee [Deploys](/doc/deploys-a1b2c3d4e5).\n'),
      'Engineering/Deploys.md': strToU8('# Deploys\n\nNothing here yet.\n'),
    })
    expect(report.degraded.filter((d) => d.code === 'sourcePageLinkKept').map((d) => d.params?.target))
      .toEqual(['/doc/deploys-a1b2c3d4e5'])
    expect(await bodyOf('Runbook')).toContain('/doc/deploys-a1b2c3d4e5')
  }, 300_000)

  it('percent-encoded paths answer the same as plain ones', async () => {
    // Docmost builds every zip path with `encodeURIComponent`, so a page whose title is not ASCII is
    // `%E3%…` in the archive AND in the links to it. An importer that compares the raw strings finds
    // nothing, and a Japanese export would go through this whole path reporting nothing at all — the
    // silence this ticket is about, surviving the fix in the one export most likely to hit it.
    await fresh()
    const report = await run({
      'Index.md': strToU8('# Index\n\n[手順書](%E6%89%8B%E9%A0%86%E6%9B%B8.md)\n'),
      '手順書.md': strToU8('# 手順書\n\nBody.\n'),
    })
    // ⚠️ The manifest is deliberately absent, for the reason in the test above it: with one, the
    // dialect resolves this link and there is nothing to report. What is measured here is the READING
    // of the encoded path — that the reporter decodes before it compares — and that has to keep
    // working for the archive nobody claims, which is the one where a missed link stays missed.
    expect(report.degraded.filter((d) => d.code === 'sourcePageLinkKept').map((d) => d.params?.target))
      .toEqual(['%E6%89%8B%E9%A0%86%E6%9B%B8.md'])
  }, 300_000)

  it('says nothing about a link whose target the archive never carried', async () => {
    // The other half, and the one that keeps this honest. A link to a page that is simply not in the
    // export is `deadCrossLinks`, and reporting it here as well would be the double-count #712
    // asked to be rid of. Break-checked by dropping the `hrefByName` test: this goes red, the cases
    // above stay green.
    await fresh()
    const report = await run({
      'Only.md': strToU8('# Only\n\n[Gone](Somewhere/Else.md) and [out](https://example.com/x.md)\n'),
    })
    expect(report.degraded.filter((d) => d.code === 'sourcePageLinkKept')).toEqual([])
  }, 300_000)

  it('says nothing about a link the vault dialect already resolved', async () => {
    // A wikilink that resolves becomes `/p/<id>` before this pass reads the text, so it cannot be
    // reported — the report describes the finished body, not the intent of an earlier pass.
    await fresh()
    const report = await run({
      'Home.md': strToU8('# Home\n\nSee [[Runbook]].\n'),
      'Runbook.md': strToU8('# Runbook\n\nStop the writer first.\n'),
    })
    expect(report.degraded.filter((d) => d.code === 'sourcePageLinkKept')).toEqual([])
    expect(await bodyOf('Home')).toContain('/p/')
  }, 300_000)
})
