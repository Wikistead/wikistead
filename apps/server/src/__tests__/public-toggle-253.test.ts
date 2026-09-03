// #253 / ADR-113: per-page anonymous public toggle + tenant parent switch. Security-critical (it writes/
// revokes the anonymous view_base@user:* grant). Real Postgres + OpenFGA. Anti-tests pin the guardrails:
// manager-only, published-only, public⊥private (a private page is rejected), noindex forced on, the grant is
// a single tuple (no orphan on unset), the parent switch is a fresh read (ON→OFF→ON).
// #885: the ledger assertion moved to `public-toggle-audit-885.test.ts` — the audit ledger is EE,
// and reaching its drain helper filtered this whole CE suite out of the published tree.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { fgaClient } from '@wikistead/authz'
import { LogicalSearchDriver } from '../search/index.js'
import { createSpace, deleteSpace } from '../routes/spaces.js'
import {
  createPage, setPagePublic, unsetPagePublic, isPagePublic, setPagePrivate, unsetPagePrivate,
  publicSurfaceEnabled,
} from '../routes/pages.js'
import type { Tenant } from '@wikistead/types'
import { privateTenant, type PrivateTenant } from './helpers/private-tenant.js'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const driver = new LogicalSearchDriver()
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'team', isolation: 'logical' }) as Tenant // team → auditLog entitled
const STRANGER = 'pub-stranger'
let pt: PrivateTenant, db: TenantDb, spaceId: string, pubPage: string, draftPage: string

const isPublicRaw = async (pageId: string): Promise<boolean> => {
  const { tuples } = await fgaClient.read({ object: `page:${pageId}`, relation: 'view_base' })
  return (tuples ?? []).some(({ key }) => key?.relation === 'view_base' && key.user === 'user:*')
}

beforeAll(async () => {
  await driver.ensureIndex()
  // #1090: a private tenant — 10 files were fighting over `tenant_dev`'s single tenant_settings row.
  pt = await privateTenant(admin, 't253', { plan: 'team' })
  db = await acquireTenantDb(asTenant(pt.id))
  spaceId = (await createSpace(db, fgaClient, { tenantId: pt.id, userId: 'dev-user', plan: 'team', name: 'pub-space' })).id
  pubPage = (await createPage(db, fgaClient, driver, { tenantId: pt.id, spaceId, userId: 'dev-user', title: 'PubPage' })).id
  draftPage = (await createPage(db, fgaClient, driver, { tenantId: pt.id, spaceId, userId: 'dev-user', title: 'DraftPage' })).id
  await admin`UPDATE pages SET published_at = now() WHERE id = ${pubPage}` // pubPage is published; draftPage stays a draft
  // Ensure a tenant_settings row exists (default OFF) — a tenant may have none yet.
  await admin`INSERT INTO tenant_settings (tenant_id, public_enabled) VALUES (${pt.id}, false) ON CONFLICT (tenant_id) DO UPDATE SET public_enabled = false`
}, 30_000)

afterAll(async () => {
  for (const id of [pubPage, draftPage]) {
    await driver.deleteDoc(id).catch(() => {})
    await admin`DELETE FROM search_outbox WHERE page_id = ${id}`.catch(() => {})
    await admin`DELETE FROM pages WHERE id = ${id}`.catch(() => {})
  }
  const targets = [`page:${pubPage}`, `page:${draftPage}`, `space:${spaceId}`]
  await admin`DELETE FROM audit_log WHERE tenant_id = ${pt.id} AND target = ANY(${targets})`.catch(() => {})
  await admin`DELETE FROM audit_outbox WHERE tenant_id = ${pt.id} AND target = ANY(${targets})`.catch(() => {})
  await deleteSpace(db, fgaClient, driver, { tenantId: pt.id, spaceId, userId: 'dev-user' }).catch(() => {})
  await admin`DELETE FROM tenant_settings WHERE tenant_id = ${pt.id}`.catch(() => {})
  await pt.dispose()
  await db.release(); await admin.end(); await pool.end()
}, 30_000)

describe('#253 setPagePublic guardrails', () => {
  it('a non-manager cannot toggle (403)', async () => {
    await expect(setPagePublic(db, fgaClient, driver, { pageId: pubPage, tenantId: pt.id, userId: STRANGER }))
      .rejects.toMatchObject({ statusCode: 403 })
    expect(await isPublicRaw(pubPage)).toBe(false)
  })

  it('a DRAFT page cannot be made public (400)', async () => {
    await expect(setPagePublic(db, fgaClient, driver, { pageId: draftPage, tenantId: pt.id, userId: 'dev-user' }))
      .rejects.toMatchObject({ statusCode: 400 })
    expect(await isPublicRaw(draftPage)).toBe(false)
  })

  it('a published page: grants view_base@user:* and forces noindex', async () => {
    await setPagePublic(db, fgaClient, driver, { pageId: pubPage, tenantId: pt.id, userId: 'dev-user', plan: 'team' })
    expect(await isPublicRaw(pubPage)).toBe(true) // anonymous grant present
    expect(await isPagePublic(db, fgaClient, { pageId: pubPage, userId: 'dev-user' })).toBe(true)
    const [row] = await admin<{ noindex: boolean }[]>`SELECT noindex FROM pages WHERE id = ${pubPage}`
    expect(row!.noindex).toBe(true) // guardrail 4: noindex forced on
  })

  it('unset removes the single grant (no orphan) and can round-trip', async () => {
    await unsetPagePublic(db, fgaClient, driver, { pageId: pubPage, tenantId: pt.id, userId: 'dev-user' })
    expect(await isPublicRaw(pubPage)).toBe(false)
    await setPagePublic(db, fgaClient, driver, { pageId: pubPage, tenantId: pt.id, userId: 'dev-user' })
    expect(await isPublicRaw(pubPage)).toBe(true)
  })

  it('public⊥private: a private page is rejected (409) and stays non-public', async () => {
    await unsetPagePublic(db, fgaClient, driver, { pageId: pubPage, tenantId: pt.id, userId: 'dev-user' })
    await setPagePrivate(db, fgaClient, driver, { pageId: pubPage, tenantId: pt.id, userId: 'dev-user' })
    await expect(setPagePublic(db, fgaClient, driver, { pageId: pubPage, tenantId: pt.id, userId: 'dev-user' }))
      .rejects.toMatchObject({ statusCode: 409 })
    expect(await isPublicRaw(pubPage)).toBe(false)
    await unsetPagePrivate(db, fgaClient, driver, { pageId: pubPage, tenantId: pt.id, userId: 'dev-user' }) // restore for isolation
  })
})

describe('#253 tenant parent switch (fresh read)', () => {
  it('reads the flag fresh: OFF → ON → OFF', async () => {
    await admin`UPDATE tenant_settings SET public_enabled = false WHERE tenant_id = ${pt.id}`
    expect(await publicSurfaceEnabled(db)).toBe(false)
    await admin`UPDATE tenant_settings SET public_enabled = true WHERE tenant_id = ${pt.id}`
    expect(await publicSurfaceEnabled(db)).toBe(true) // immediate (no cache)
    await admin`UPDATE tenant_settings SET public_enabled = false WHERE tenant_id = ${pt.id}`
    expect(await publicSurfaceEnabled(db)).toBe(false)
    // Restore ON: this tenant is private now, so this is just this file's own steady state, not a
    // courtesy to other files sharing `tenant_dev` (#482 no longer applies here).
    await admin`UPDATE tenant_settings SET public_enabled = true WHERE tenant_id = ${pt.id}`
  })
})
