// #862 an event about a page whose privacy is INHERITED used to leave the workspace.
//
// `pageEventDisposition` is the one definition of what may leave the fortress — the webhook drain and
// the mention email both ask it (#547 / ADR-196 §4 R1). It read the page's stored tuples and suppressed
// on a `private` relation. But the model says
//
//     define private: [user:*, share_link:*] or private from parent
//
// and `setPagePrivate` writes the marker on the ROOT only, because ADR-103 decision 2b makes the
// subtree private through the parent chain rather than by writing a marker on every descendant. A
// stored-tuple read cannot see a computed relation, so every DESCENDANT of a private folder answered
// `deliver` — measured before the fix: the child was `private = true` at the store and `deliver` here.
//
// The blast radius is everything that carries a pageId: about twenty-five event types once the
// catalogue reached the outbox, plus every mention email about a page under a private parent.
//
// ⚠️ The walks below are a PAIR, and the second one is why: a fix that suppressed everything would
// satisfy the first alone. A sibling that is NOT under the private folder must still be delivered.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { TenantRegistry } from '../db/registry.js'
import { acquireTenantDb } from '../db/tenant-db.js'
import type { TenantDb } from '../db/index.js'
import { fgaClient, writeTuples, checkRelation } from '@wikistead/authz'
import { LogicalSearchDriver } from '../search/index.js'
import { createSpace, deleteSpace } from '../routes/spaces.js'
import { createPage, setPagePrivate } from '../routes/pages.js'
import { pageEventDisposition } from '../page-disposition.js'
import type { Tenant } from '@wikistead/types'

const driver = new LogicalSearchDriver()
const admin = postgres(process.env.DATABASE_ADMIN_URL!)
let tenant: Tenant, db: TenantDb, spaceId: string
let folder: string, child: string, grandchild: string, sibling: string, legacy: string

/** Published and linked to its space — the state in which an event about it would be delivered. */
async function visible(title: string, parentId?: string): Promise<string> {
  const id = (await createPage(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user', title, ...(parentId ? { parentId } : {}) })).id
  await admin`UPDATE pages SET published_at = now() WHERE id = ${id}`
  await writeTuples(fgaClient, [{ user: `space:${spaceId}`, relation: 'space', object: `page:${id}` }])
  return id
}

beforeAll(async () => {
  tenant = (await new TenantRegistry(pool).findBySlug('dev'))!
  db = await acquireTenantDb(tenant)
  spaceId = (await createSpace(db, fgaClient, { tenantId: tenant.id, userId: 'dev-user', plan: tenant.plan, name: 'inh-862' })).id
  folder = await visible('inh862 folder')
  child = await visible('inh862 child', folder)
  grandchild = await visible('inh862 grandchild', child)
  sibling = await visible('inh862 sibling') // NOT under the folder
  // A page privatised before #244's backfill holds only the guest half of the marker pair. It is real
  // (the backfill exists because such rows exist) and it is the one case the store read catches and a
  // `user:`-subject check does not.
  legacy = await visible('inh862 legacy guest-only marker')
  await writeTuples(fgaClient, [{ user: 'share_link:*', relation: 'private', object: `page:${legacy}` }])
  await setPagePrivate(db, fgaClient, driver, { pageId: folder, tenantId: tenant.id, userId: 'dev-user' })
}, 180_000)

afterAll(async () => {
  await deleteSpace(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user' }).catch(() => {})
  await db.release(); await pool.end(); await admin.end()
}, 120_000)

describe('#862 an inherited private page is not spoken of', () => {
  it('the store agrees the whole subtree is private, and only the root holds a marker', async () => {
    // Without this the walk below could pass because the pages are private for some other reason, or
    // because privatising failed outright and nothing is deliverable.
    for (const [name, id] of [['folder', folder], ['child', child], ['grandchild', grandchild]] as const) {
      expect(await checkRelation(fgaClient, 'user:inh862-probe', 'private', { type: 'page', id }), `${name} is private at the store`).toBe(true)
    }
    expect(await checkRelation(fgaClient, 'user:inh862-probe', 'private', { type: 'page', id: sibling }), 'the sibling is not').toBe(false)
  }, 60_000)

  it('⚠️ a descendant of a private folder is suppressed, at every depth', async () => {
    expect(await pageEventDisposition(fgaClient, { pageId: folder }), 'the root, which does hold a marker').toBe('suppress')
    expect(await pageEventDisposition(fgaClient, { pageId: child }), 'one level down — this used to say deliver').toBe('suppress')
    expect(await pageEventDisposition(fgaClient, { pageId: grandchild }), 'and two, because the chain is what carries it').toBe('suppress')
  }, 60_000)

  it('⚠️ and a page that is NOT under it is still delivered', async () => {
    // The half that keeps the fix from being "suppress everything". Both drains read this one
    // function, so an over-broad answer would silently stop every webhook and every mention email.
    expect(await pageEventDisposition(fgaClient, { pageId: sibling })).toBe('deliver')
  }, 60_000)

  it('⚠️ a legacy page holding only the guest half of the marker is suppressed too', async () => {
    // #228 review point 3 chose to suppress on ANY `private` relation rather than on `private@user:*`,
    // and this is the case that choice is for. A check with a `user:` subject answers `false` here —
    // measured: removing the store read leaves every other walk in this file green.
    expect(await checkRelation(fgaClient, 'user:inh862-probe', 'private', { type: 'page', id: legacy }),
      'the check cannot see it, which is the point').toBe(false)
    expect(await pageEventDisposition(fgaClient, { pageId: legacy }), 'the store read can').toBe('suppress')
  }, 60_000)

  it('a payload with no pageId is not a page question at all', async () => {
    expect(await pageEventDisposition(fgaClient, { actorId: 'user-1' })).toBe('deliver')
  }, 60_000)
})
