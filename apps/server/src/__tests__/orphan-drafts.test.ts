// Integration test — real Postgres + OpenFGA. Orphan-draft admin handoff, READ side
// (#99 / ADR-061). authz-critical: enumeration must list ACTUALLY-orphaned drafts only
// (creator gone + no live viewer), never a live creator's / live-shared strict-private
// draft, and the capability is hidden (404) from non-admins.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import * as Y from 'yjs'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { fgaClient, deleteObjectTuples, writeTuples } from '@wikistead/authz'
import { LogicalSearchDriver } from '../search/index.js'
import { LogicalStorageDriver } from '../storage/index.js'
import { createPage, publishPage } from '../routes/pages.js'
import { createSpace, deleteSpace } from '../routes/spaces.js'
import { listOrphanDrafts, requireTenantAdminOr404, claimOrphanDraft, reassignOrphanDraft, isOrphanPage } from '../routes/orphan-drafts.js'
import { sweepExpiredClaims } from '../scripts/orphan-claim-sweep.js'
import { drainAuditOutbox } from '../audit/outbox.js'
import type { Tenant } from '@wikistead/types'

const NEW_OWNER = 'orphan-new-owner-sub'
const canManage = async (sub: string, pageId: string) =>
  (await fgaClient.check({ user: `user:${sub}`, relation: 'manage', object: `page:${pageId}` })).allowed === true

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const driver = new LogicalSearchDriver()
const storage = new LogicalStorageDriver()
const TENANT = 'tenant_dev'
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'free', isolation: 'logical' }) as Tenant
const ydoc = (t: string) => Buffer.from(Y.encodeStateAsUpdate((() => { const d = new Y.Doc(); d.getText('content').insert(0, t); return d })()))

let db: TenantDb
let spaceId: string
const pageIds: string[] = []

async function mkPage(title: string): Promise<string> {
  // dev-user is a space manager (created the space), so createPage is authorized; it writes
  // dev-user's `manage` tuple = the strict-private draft state (no page#space until publish).
  const p = await createPage(db, fgaClient, driver, { tenantId: TENANT, spaceId, userId: 'dev-user', title })
  pageIds.push(p.id)
  return p.id
}

const ids = async () => (await listOrphanDrafts(db, fgaClient, { tenantId: TENANT })).map((o) => o.id)

beforeAll(async () => {
  await driver.ensureIndex()
  db = await acquireTenantDb(asTenant(TENANT))
  spaceId = (await createSpace(db, fgaClient, { tenantId: TENANT, userId: 'dev-user', plan: 'free', name: `orphan-sp-${Date.now().toString(36)}` })).id
  // A second live member to receive a reassign (distinct from the admin, so the reassign's
  // write-new-owner + revoke-admin-grant don't touch the same tuple).
  await admin`INSERT INTO members (tenant_id, sub, role) VALUES (${TENANT}, ${NEW_OWNER}, 'member') ON CONFLICT (tenant_id, sub) DO NOTHING`
}, 30_000)

afterAll(async () => {
  for (const id of pageIds) {
    await deleteObjectTuples(fgaClient, `page:${id}`).catch(() => {})
    await admin`DELETE FROM search_outbox WHERE page_id = ${id}`.catch(() => {})
    await admin`DELETE FROM pages WHERE id = ${id}`.catch(() => {})
  }
  await admin`DELETE FROM orphan_claims WHERE tenant_id = ${TENANT}`.catch(() => {})
  await admin`DELETE FROM audit_log WHERE tenant_id = ${TENANT}`.catch(() => {})
  await admin`DELETE FROM audit_outbox WHERE tenant_id = ${TENANT}`.catch(() => {})
  await admin`DELETE FROM members WHERE tenant_id = ${TENANT} AND sub = ${NEW_OWNER}`.catch(() => {})
  await deleteSpace(db, fgaClient, driver, { tenantId: TENANT, spaceId, userId: 'dev-user' }).catch(() => {})
  await db.release()
  await admin.end()
  await pool.end()
}, 30_000)

describe('listOrphanDrafts (#99 / ADR-061 read side)', () => {
  it('lists a draft whose creator tuple is gone (zero live grants) as an orphan', async () => {
    const orphan = await mkPage('orphan-zero-grant')
    await deleteObjectTuples(fgaClient, `page:${orphan}`) // simulate creator deletion → all tuples gone
    expect(await ids()).toContain(orphan)
  })

  it('lists a draft whose only grant points at a NON-member (deleted creator) as an orphan', async () => {
    const orphan = await mkPage('orphan-stale-grant')
    await deleteObjectTuples(fgaClient, `page:${orphan}`)
    // A leftover grant for a user who is NOT a tenant member must not count as "reachable".
    await writeTuples(fgaClient, [{ user: 'user:ghost-deleted-creator', relation: 'manage', object: `page:${orphan}` }])
    expect(await ids()).toContain(orphan)
  })

  it('does NOT list a draft a live member can still reach (strict-private for live creators holds)', async () => {
    const live = await mkPage('live-creator') // keeps dev-user's manage tuple; dev-user is a member
    const result = await ids()
    expect(result).not.toContain(live)
    // and a live VIEWER (non-creator path): creator tuple gone but a live member holds view
    const shared = await mkPage('live-viewer')
    await deleteObjectTuples(fgaClient, `page:${shared}`)
    await writeTuples(fgaClient, [{ user: 'user:dev-user', relation: 'view', object: `page:${shared}` }]) // dev-user is live
    expect(await ids()).not.toContain(shared)
  })

  it('does NOT list a PUBLISHED page (published_at set ⇒ not a draft candidate)', async () => {
    const pub = await mkPage('published-not-orphan')
    await admin`UPDATE pages SET ydoc = ${ydoc('# pub\n')} WHERE id = ${pub}`
    await publishPage(db, fgaClient, driver, storage, { pageId: pub, subject: 'user:dev-user', createdBy: 'user:dev-user' })
    // Even after stripping its grants, a published page is not a draft → never an orphan candidate.
    await deleteObjectTuples(fgaClient, `page:${pub}`)
    expect(await ids()).not.toContain(pub)
  })
})

async function mkOrphan(title: string): Promise<string> {
  const id = await mkPage(title)
  await deleteObjectTuples(fgaClient, `page:${id}`) // creator gone → orphan
  return id
}

describe('claimOrphanDraft (#99 / ADR-061 — temp grant + TOCTOU)', () => {
  it('grants the admin a temporary manage grant on a real orphan', async () => {
    const id = await mkOrphan('claim-ok')
    const r = await claimOrphanDraft(db, fgaClient, { tenantId: TENANT, pageId: id, adminSub: 'dev-user' })
    expect(r.pageId).toBe(id)
    expect(await canManage('dev-user', id)).toBe(true)          // admin can now read it
    expect(await isOrphanPage(db, fgaClient, id)).toBe(false)   // claimed → no longer orphan
  })

  it('records a durable orphan_draft.claimed audit entry when entitled + plan passed (#177)', async () => {
    const id = await mkOrphan('claim-audited')
    await claimOrphanDraft(db, fgaClient, { tenantId: TENANT, pageId: id, adminSub: 'dev-user', plan: 'team' }) // default UNLIMITED resolver → auditLog
    expect(await drainAuditOutbox()).toBeGreaterThanOrEqual(1)
    const rows = await db.sql<{ action: string; target: string; actor: string }[]>`SELECT action, target, actor FROM audit_log WHERE tenant_id = ${TENANT} ORDER BY seq`
    expect(rows.some((r) => r.action === 'orphan_draft.claimed' && r.target === `page:${id}` && r.actor === 'user:dev-user')).toBe(true)
  })

  it('REFUSES to claim a live strict-private page (TOCTOU re-check, 404 — bypass impossible)', async () => {
    const live = await mkPage('claim-live-denied') // dev-user keeps manage; dev-user is a live member
    await expect(claimOrphanDraft(db, fgaClient, { tenantId: TENANT, pageId: live, adminSub: 'dev-user' }))
      .rejects.toMatchObject({ statusCode: 404 })
  })
})

describe('reassignOrphanDraft (#99 / ADR-061 — hand off + revoke admin)', () => {
  it('grants the new owner and REVOKES the admin temp grant; clears the claim', async () => {
    const id = await mkOrphan('reassign-ok')
    await claimOrphanDraft(db, fgaClient, { tenantId: TENANT, pageId: id, adminSub: 'dev-user' })
    await reassignOrphanDraft(db, fgaClient, { tenantId: TENANT, pageId: id, adminSub: 'dev-user', newOwnerSub: NEW_OWNER })
    expect(await canManage(NEW_OWNER, id)).toBe(true)  // new owner reachable
    expect(await canManage('dev-user', id)).toBe(false) // admin temp access revoked
    const [row] = await admin`SELECT 1 FROM orphan_claims WHERE tenant_id = ${TENANT} AND page_id = ${id}`
    expect(row).toBeUndefined() // claim cleared
  })

  it('rejects reassign to a NON-member (tenant isolation / member-only)', async () => {
    const id = await mkOrphan('reassign-nonmember')
    await claimOrphanDraft(db, fgaClient, { tenantId: TENANT, pageId: id, adminSub: 'dev-user' })
    await expect(reassignOrphanDraft(db, fgaClient, { tenantId: TENANT, pageId: id, adminSub: 'dev-user', newOwnerSub: 'not-a-member-xyz' }))
      .rejects.toMatchObject({ statusCode: 400, code: 'not_a_member' })
  })

  it('rejects reassign without an active claim (404 — must claim first)', async () => {
    const id = await mkOrphan('reassign-noclaim')
    await expect(reassignOrphanDraft(db, fgaClient, { tenantId: TENANT, pageId: id, adminSub: 'dev-user', newOwnerSub: NEW_OWNER }))
      .rejects.toMatchObject({ statusCode: 404 })
  })
})

describe('sweepExpiredClaims (#99 / ADR-061 — TTL back to orphan)', () => {
  it('revokes an expired claim grant and returns the page to orphan', async () => {
    const id = await mkOrphan('sweep-ttl')
    await claimOrphanDraft(db, fgaClient, { tenantId: TENANT, pageId: id, adminSub: 'dev-user' })
    expect(await canManage('dev-user', id)).toBe(true)
    await admin`UPDATE orphan_claims SET expires_at = now() - interval '1 second' WHERE tenant_id = ${TENANT} AND page_id = ${id}`
    const n = await sweepExpiredClaims(admin, fgaClient)
    expect(n).toBeGreaterThanOrEqual(1)
    expect(await canManage('dev-user', id)).toBe(false)        // temp grant revoked
    expect(await isOrphanPage(db, fgaClient, id)).toBe(true)   // claimable again
  })
})

describe('requireTenantAdminOr404 (existence-hiding gate)', () => {
  it('rejects a non-admin with 404 (not 403 — capability existence hidden)', async () => {
    await expect(requireTenantAdminOr404(fgaClient, 'orphan-stranger-nonadmin', TENANT))
      .rejects.toMatchObject({ statusCode: 404 })
  })

  it('admits a tenant#admin (dev-user)', async () => {
    await expect(requireTenantAdminOr404(fgaClient, 'dev-user', TENANT)).resolves.toBeUndefined()
  })
})
