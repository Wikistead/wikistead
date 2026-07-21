// #364 / ADR-157: the space HOMEPAGE — a pointer at a regular page. The design-review anti-tests
// atomic create (edit gate, 409 on second), the pointer existence-ORACLE guard (a viewer who cannot
// see the home gets a listSpaces row byte-identical to "no home set"), the root-listing exclusion
// (listPages skips the home; pins-class surfaces deliberately include it), the LEAF guards
// (createPage under home / movePage onto or under home → 400), deletePage(home) clearing the pointer
// via the FK, the export `_home.md` + manifest mapping with the import round-trip, and the public
// space route gating (published+ANON-viewable home only). Real Postgres + OpenFGA + Fastify.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { readFile } from 'node:fs/promises'
import postgres from 'postgres'
import { unzipSync, strFromU8 } from 'fflate'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { fgaClient, writeTuples, deleteTuples, deleteObjectTuples } from '@wikistead/authz'
import { LogicalSearchDriver } from '../search/index.js'
import { LogicalStorageDriver } from '../storage/index.js'
import { createSpace, deleteSpace, createSpaceHome, listSpaces, updateSpace } from '../routes/spaces.js'
import { createPage, deletePage, listPages, movePage, publishPage, updatePage } from '../routes/pages.js'
import { buildSpaceExport } from '../export/index.js'
import { importArchive } from '../import/index.js'
import { buildApp } from '../app.js'
import { mintGuestToken } from '@wikistead/auth'
import type { Tenant } from '@wikistead/types'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const driver = new LogicalSearchDriver()
const storage = new LogicalStorageDriver()
const TENANT = 'tenant_dev'
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'free', isolation: 'logical' }) as Tenant
const VIEWER = 'home364-viewer'

let app: FastifyInstance
let db: TenantDb
let spaceId: string
const cleanupPages: string[] = []

beforeAll(async () => {
  app = await buildApp()
  await app.ready()
  await driver.ensureIndex()
  await storage.ensureBucket()
  db = await acquireTenantDb(asTenant(TENANT))
  spaceId = (await createSpace(db, fgaClient, { tenantId: TENANT, userId: 'dev-user', plan: 'free', name: `home364-${Date.now().toString(36)}` })).id
  // a plain member who can VIEW the space but is not its manager (for the oracle test)
  await writeTuples(fgaClient, [{ user: `user:${VIEWER}`, relation: 'viewer', object: `space:${spaceId}` }])
}, 60_000)

afterAll(async () => {
  await deleteTuples(fgaClient, [{ user: `user:${VIEWER}`, relation: 'viewer', object: `space:${spaceId}` }]).catch(() => {})
  for (const id of cleanupPages) {
    await deleteObjectTuples(fgaClient, `page:${id}`).catch(() => {})
    await admin`DELETE FROM revisions WHERE page_id = ${id}`.catch(() => {})
    await admin`DELETE FROM search_outbox WHERE page_id = ${id}`.catch(() => {})
    await admin`DELETE FROM pages WHERE id = ${id}`.catch(() => {})
  }
  await deleteSpace(db, fgaClient, driver, { tenantId: TENANT, spaceId, userId: 'dev-user' }).catch(() => {})
  await db.release()
  await app.close()
  await admin.end()
  await pool.end()
}, 60_000)

describe('#364 space home — create / gates / oracle', () => {
  let homeId: string

  it('create: edit-gated, titles the page after the space, sets the pointer atomically; second create → 409', async () => {
    await expect(createSpaceHome(db, fgaClient, driver, { tenantId: TENANT, spaceId, userId: 'home364-nobody' }))
      .rejects.toMatchObject({ statusCode: 403 })
    const created = await createSpaceHome(db, fgaClient, driver, { tenantId: TENANT, spaceId, userId: 'dev-user' })
    homeId = created.id
    cleanupPages.push(homeId)
    const [row] = await admin`SELECT home_page_id FROM spaces WHERE id = ${spaceId}`
    expect(row!.home_page_id).toBe(homeId)
    await expect(createSpaceHome(db, fgaClient, driver, { tenantId: TENANT, spaceId, userId: 'dev-user' }))
      .rejects.toMatchObject({ statusCode: 409 })
    // the 409 race path must NOT leave an orphan page behind (rollback pin): only ONE page carries the title
    const pages = await admin`SELECT id FROM pages WHERE space_id = ${spaceId} AND deleted_at IS NULL`
    expect(pages.length).toBe(1)
  })

  it('ORACLE guard: a space viewer who cannot view the (draft) home sees homePageId null — byte-identical to unset', async () => {
    // the fresh home is an UNPUBLISHED draft → creator-only (Phase-4 gate); the viewer can't view it
    const forViewer = await listSpaces(db, fgaClient, VIEWER)
    const mine = forViewer.find((s) => s.id === spaceId)
    expect(mine, 'the space itself is visible to the viewer').toBeTruthy()
    expect(mine!.homePageId ?? null, 'the pointer is OMITTED for a non-viewer of the home').toBeNull()
    // the creator sees it
    const forCreator = await listSpaces(db, fgaClient, 'dev-user')
    expect(forCreator.find((s) => s.id === spaceId)!.homePageId).toBe(homeId)
    // publish → space members inherit view → the viewer NOW gets the pointer
    await admin`UPDATE pages SET ydoc = NULL WHERE id = ${homeId}` // keep the doc empty; publish snapshots ''
    await publishPage(db, fgaClient, driver, storage, { pageId: homeId, subject: 'user:dev-user', createdBy: 'user:dev-user' })
    const after = await listSpaces(db, fgaClient, VIEWER)
    expect(after.find((s) => s.id === spaceId)!.homePageId).toBe(homeId)
  })

  it('root-listing exclusion: listPages (member + guest shared route) omits the home; other pages stay', async () => {
    const other = await createPage(db, fgaClient, driver, { tenantId: TENANT, spaceId, userId: 'dev-user', title: 'regular' })
    cleanupPages.push(other.id)
    const tree = await listPages(db, fgaClient, { spaceId, subject: 'user:dev-user' })
    expect(tree.some((p) => p.id === homeId), 'home absent from the tree').toBe(false)
    expect(tree.some((p) => p.id === other.id), 'regular pages still listed').toBe(true)
  })

  it('LEAF guards: createPage under home, movePage under home, movePage(home → parent) — all 400', async () => {
    const other = (await listPages(db, fgaClient, { spaceId, subject: 'user:dev-user' })).find((p) => p.title === 'regular')!
    await expect(createPage(db, fgaClient, driver, { tenantId: TENANT, spaceId, userId: 'dev-user', title: 'x', parentId: homeId }))
      .rejects.toMatchObject({ statusCode: 400 })
    await expect(movePage(db, fgaClient, driver, { pageId: other.id, userId: 'dev-user', parentId: homeId, afterId: null }))
      .rejects.toMatchObject({ statusCode: 400 })
    await expect(movePage(db, fgaClient, driver, { pageId: homeId, userId: 'dev-user', parentId: other.id, afterId: null }))
      .rejects.toMatchObject({ statusCode: 400 })
  })

  it('export: the home is `_home.md` at the archive root (no page dir); the manifest carries the pointer', async () => {
    await admin`UPDATE pages SET published_md = ${'# Welcome home'} WHERE id = ${homeId}`
    const result = await buildSpaceExport(db, fgaClient, storage, { userId: 'dev-user', spaceId })
    expect(result).toBeTruthy()
    const files = unzipSync(result!.body)
    expect(files['_home.md'], '_home.md at the ZIP root').toBeTruthy()
    expect(strFromU8(files['_home.md']!)).toContain('Welcome home')
    const manifest = JSON.parse(strFromU8(files['manifest.json']!)) as { homes?: { spaceDir: string; oldId: string }[]; pages: { dir: string }[] }
    expect(manifest.homes).toEqual([{ spaceDir: '', oldId: homeId }])
    // no duplicate body: the home has NO page directory of its own
    expect(Object.keys(files).some((f) => f !== '_home.md' && f.endsWith('/index.md') && strFromU8(files[f]!).includes('Welcome home'))).toBe(false)
  })

  it('import: `_home.md` restores the pointer into a home-less space; a space WITH a home keeps it (regular page instead)', async () => {
    const exported = await buildSpaceExport(db, fgaClient, storage, { userId: 'dev-user', spaceId })
    // target A: fresh space with NO home → pointer restored
    const freshA = await createSpace(db, fgaClient, { tenantId: TENANT, userId: 'dev-user', plan: 'free', name: `home364-a-${Date.now().toString(36)}` })
    const reportA = await importArchive({ db, fga: fgaClient, storage, driver }, exported!.body, { tenantId: TENANT, spaceId: freshA.id, userId: 'dev-user', plan: 'free' })
    expect(reportA.pagesCreated).toBeGreaterThanOrEqual(2) // home + regular
    const [ptrA] = await admin`SELECT home_page_id FROM spaces WHERE id = ${freshA.id}`
    expect(ptrA!.home_page_id, 'pointer restored from the archive').toBeTruthy()
    // target B: a space that ALREADY has a home → never overwritten; the archive home lands as a regular page
    const freshB = await createSpace(db, fgaClient, { tenantId: TENANT, userId: 'dev-user', plan: 'free', name: `home364-b-${Date.now().toString(36)}` })
    const bHome = await createSpaceHome(db, fgaClient, driver, { tenantId: TENANT, spaceId: freshB.id, userId: 'dev-user' })
    await importArchive({ db, fga: fgaClient, storage, driver }, exported!.body, { tenantId: TENANT, spaceId: freshB.id, userId: 'dev-user', plan: 'free' })
    const [ptrB] = await admin`SELECT home_page_id FROM spaces WHERE id = ${freshB.id}`
    expect(ptrB!.home_page_id, 'the existing home is never silently overwritten').toBe(bHome.id)
    // cleanup both spaces (their pages ride the space delete)
    for (const sid of [freshA.id, freshB.id]) {
      const rows = await admin`SELECT id FROM pages WHERE space_id = ${sid}`
      for (const r of rows) { await deleteObjectTuples(fgaClient, `page:${r.id}`).catch(() => {}); await admin`DELETE FROM search_outbox WHERE page_id = ${r.id}`.catch(() => {}) }
      await deleteSpace(db, fgaClient, driver, { tenantId: TENANT, spaceId: sid, userId: 'dev-user' }).catch(() => {})
    }
  })

  it('deletePage(home) clears the pointer via the FK (SET NULL) — the space degrades to the empty state', async () => {
    await deletePage(db, fgaClient, driver, { pageId: homeId, userId: 'dev-user' })
    const [row] = await admin`SELECT home_page_id FROM spaces WHERE id = ${spaceId}`
    expect(row!.home_page_id).toBeNull()
  })
})

describe('#364(plan A): the STORED home title is the space name — no language suffix', () => {
  let sid: string
  let hid: string
  let prevLang: string | null = null

  beforeAll(async () => {
    const [row] = await admin`SELECT default_lang FROM tenant_settings LIMIT 1`
    prevLang = (row?.default_lang as string | undefined) ?? null
  })
  afterAll(async () => {
    await admin`UPDATE tenant_settings SET default_lang = ${prevLang}`.catch(() => {})
    if (sid) {
      const rows = await admin`SELECT id FROM pages WHERE space_id = ${sid}`
      for (const r of rows) { await deleteObjectTuples(fgaClient, `page:${r.id}`).catch(() => {}); await admin`DELETE FROM search_outbox WHERE page_id = ${r.id}`.catch(() => {}) }
      await deleteSpace(db, fgaClient, driver, { tenantId: TENANT, spaceId: sid, userId: 'dev-user' }).catch(() => {})
    }
  })

  it('creation stores the SPACE NAME as the title — no suffix, regardless of the tenant default language', async () => {
    //(plan A): the "Home / " wording is a viewer-side i18n label, never a stored value
    // search / pins keep one language-stable title and the display follows the VIEWER language instead.
    await admin`INSERT INTO tenant_settings (tenant_id, default_lang) VALUES (${TENANT}, 'ja')
      ON CONFLICT (tenant_id) DO UPDATE SET default_lang = 'ja'`
    const jaName = `home364t-ja-${Date.now().toString(36)}`
    sid = (await createSpace(db, fgaClient, { tenantId: TENANT, userId: 'dev-user', plan: 'free', name: jaName })).id
    hid = (await createSpaceHome(db, fgaClient, driver, { tenantId: TENANT, spaceId: sid, userId: 'dev-user' })).id
    const [ja] = await admin`SELECT title FROM pages WHERE id = ${hid}`
    expect(ja!.title).toBe(jaName) // bare space name — no suffix even under default_lang=ja
    await admin`UPDATE tenant_settings SET default_lang = 'en'`
    const enName = `home364t-en-${Date.now().toString(36)}`
    const sid2 = (await createSpace(db, fgaClient, { tenantId: TENANT, userId: 'dev-user', plan: 'free', name: enName })).id
    const hid2 = (await createSpaceHome(db, fgaClient, driver, { tenantId: TENANT, spaceId: sid2, userId: 'dev-user' })).id
    const [en] = await admin`SELECT title FROM pages WHERE id = ${hid2}`
    expect(en!.title).toBe(enName) // bare space name — no " Home" suffix either
    const rows = await admin`SELECT id FROM pages WHERE space_id = ${sid2}`
    for (const r of rows) { await deleteObjectTuples(fgaClient, `page:${r.id}`).catch(() => {}); await admin`DELETE FROM search_outbox WHERE page_id = ${r.id}`.catch(() => {}) }
    await deleteSpace(db, fgaClient, driver, { tenantId: TENANT, spaceId: sid2, userId: 'dev-user' }).catch(() => {})
  })

  it('PATCH title on a home is refused (400) — the server is the fortress, not the hidden UI', async () => {
    await expect(updatePage(db, fgaClient, driver, { pageId: hid, userId: 'dev-user', title: 'sneaky rename' }))
      .rejects.toMatchObject({ statusCode: 400 })
    const [row] = await admin`SELECT title FROM pages WHERE id = ${hid}`
    expect(row!.title).not.toContain('のホーム') // still the bare space name (the 400 changed nothing)
  })

  it('a space rename re-writes the home title to the NEW space name in the same tx', async () => {
    const nextName = `home364t-renamed-${Date.now().toString(36)}`
    await updateSpace(db, fgaClient, { spaceId: sid, userId: 'dev-user', name: nextName, driver })
    const [row] = await admin`SELECT title FROM pages WHERE id = ${hid}`
    expect(row!.title).toBe(nextName) // bare name follows the rename — never a suffixed variant
  })
})

// #364①: the GUEST /share) home wiring — /spaces/:id/info exposes homePageId VIEW-GATED for the
// share_link principal (ADR-157 §2 oracle guard carried to the guest surface): an UNPUBLISHED home is
// byte-identically null (existence-hidden); a published, link-covered home returns its id — on view AND
// edit links alike. Fastify app + real minted guest tokens.
describe('#364①: guest space info home pointer (view-gated, existence-hiding)', () => {
  let app: FastifyInstance
  let sid: string
  let hid: string
  const guestCfg = { secret: process.env.GUEST_TOKEN_SECRET!, ttlSeconds: 3600 }
  const dev = { host: 'dev.localhost', authorization: 'Bearer dev-token', 'content-type': 'application/json' }
  let seq = 0
  const anon = () => `anon:${(Date.now() + seq++).toString(16).slice(-12).padStart(12, '0')}`

  const spaceTok = async (capability: 'view' | 'edit') => {
    const r = await app.inject({ method: 'POST', url: '/share-links', headers: dev, payload: { resource: { type: 'space', id: sid }, capability, expiresInSeconds: null } })
    expect(r.statusCode, r.body).toBe(201)
    return mintGuestToken(guestCfg, { tenantId: TENANT, shareLinkId: (r.json() as { id: string }).id, resource: { type: 'space', id: sid }, capability, anonId: anon() })
  }
  const infoAs = async (token: string) =>
    app.inject({ method: 'GET', url: `/spaces/${sid}/info`, headers: { host: 'dev.localhost', authorization: `Bearer ${token}` } })

  beforeAll(async () => {
    app = await buildApp()
    await app.ready()
    sid = (await createSpace(db, fgaClient, { tenantId: TENANT, userId: 'dev-user', plan: 'free', name: `home364g-${Date.now().toString(36)}` })).id
    hid = (await createSpaceHome(db, fgaClient, driver, { tenantId: TENANT, spaceId: sid, userId: 'dev-user' })).id
  }, 60_000)
  afterAll(async () => {
    await app.close()
    const rows = await admin`SELECT id FROM pages WHERE space_id = ${sid}`
    for (const r of rows) { await deleteObjectTuples(fgaClient, `page:${r.id}`).catch(() => {}); await admin`DELETE FROM search_outbox WHERE page_id = ${r.id}`.catch(() => {}) }
    await deleteSpace(db, fgaClient, driver, { tenantId: TENANT, spaceId: sid, userId: 'dev-user' }).catch(() => {})
  }, 60_000)

  it('ANTI-TEST: an UNPUBLISHED home is null for a space-link guest (no existence oracle), on view AND edit links', async () => {
    for (const cap of ['view', 'edit'] as const) {
      const res = await infoAs(await spaceTok(cap))
      expect(res.statusCode, res.body).toBe(200)
      expect((res.json() as { homePageId: string | null }).homePageId, `${cap} link`).toBeNull()
    }
  })

  it('a PUBLISHED home returns its id to the guest (both capabilities); the member sees it too', async () => {
    const pub = await app.inject({ method: 'POST', url: `/pages/${hid}/publish`, headers: dev, payload: {} })
    expect(pub.statusCode, pub.body).toBe(200)
    for (const cap of ['view', 'edit'] as const) {
      const res = await infoAs(await spaceTok(cap))
      expect(res.statusCode).toBe(200)
      expect((res.json() as { homePageId: string | null }).homePageId, `${cap} link`).toBe(hid)
    }
    const member = await app.inject({ method: 'GET', url: `/spaces/${sid}/info`, headers: dev })
    expect((member.json() as { homePageId: string | null }).homePageId).toBe(hid)
  })
})

// #364the ruling-A BACKFILL. Homes created beforestored the LABEL SUFFIX in
// `pages.title` ("<Space>"); the title band then re-applied the label and rendered it twice.
// Migration 077 restates the invariant on existing rows (home title IS the space name) and enqueues
// the search reindex through the trusted outbox path. Pinned by REPLAYING the migration against a
// deliberately drifted row — the exact fixture the previous pass never had (it only ever checked a
// FRESHLY created home, which was correct by construction and hid the gap).
describe('#364— migration 077 normalises pre-ruling home titles', () => {
  let mSpaceId: string
  beforeAll(async () => {
    mSpaceId = (await createSpace(db, fgaClient, { tenantId: TENANT, userId: 'dev-user', plan: 'free', name: `home364m-${Date.now().toString(36)}` })).id
  }, 60_000)
  afterAll(async () => {
    await deleteSpace(db, fgaClient, driver, { tenantId: TENANT, spaceId: mSpaceId, userId: 'dev-user' }).catch(() => {})
  }, 60_000)

  it('a suffix-baked (and a drifted) home title is restated to the space name, with a reindex enqueued', async () => {
    const created = await createSpaceHome(db, fgaClient, driver, { tenantId: TENANT, spaceId: mSpaceId, userId: 'dev-user' })
    cleanupPages.push(created.id)
    const [{ name: spaceName }] = await admin<[{ name: string }]>`SELECT name FROM spaces WHERE id = ${mSpaceId}`
    // publish so the row is search-indexed (the outbox enqueue is scoped to published, live homes)
    await publishPage(db, fgaClient, driver, storage, { pageId: created.id, subject: 'user:dev-user', createdBy: 'user:dev-user' })
    // drift it exactly like a pre-c2330 home
    await admin`UPDATE pages SET title = ${`${spaceName}のホーム`} WHERE id = ${created.id}`
    await admin`DELETE FROM search_outbox WHERE page_id = ${created.id}`

    const sqlText = await readFile(new URL('../../../../infra/db/migrations/077_home_title_backfill.sql', import.meta.url), 'utf8')
    await admin.unsafe(sqlText)

    const [after] = await admin<[{ title: string }]>`SELECT title FROM pages WHERE id = ${created.id}`
    expect(after.title, 'the stored title is the bare space name (no baked suffix)').toBe(spaceName)
    const [{ n }] = await admin<[{ n: number }]>`SELECT count(*)::int AS n FROM search_outbox WHERE page_id = ${created.id} AND operation = 'upsert'`
    expect(n, 'the title change is reindexed through the outbox, not silently left stale').toBeGreaterThan(0)

    // Idempotent: a second run changes nothing (and the run is safe to replay on every deploy).
    await admin.unsafe(sqlText)
    const [again] = await admin<[{ title: string }]>`SELECT title FROM pages WHERE id = ${created.id}`
    expect(again.title).toBe(spaceName)

    // And a DRIFTED row (space renamed while the home kept the old name) is restated too — the
    // invariant is "title = space name", which a suffix-stripping rewrite would have missed.
    await admin`UPDATE pages SET title = 'stale-drifted-name' WHERE id = ${created.id}`
    await admin.unsafe(sqlText)
    const [drift] = await admin<[{ title: string }]>`SELECT title FROM pages WHERE id = ${created.id}`
    expect(drift.title).toBe(spaceName)
  })
})
