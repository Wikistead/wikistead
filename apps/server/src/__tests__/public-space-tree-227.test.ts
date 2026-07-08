// #227 / ADR-030: the space-level public page tree (GET /public/spaces/:id/pages) for the anonymous
// read-only reader-chrome. Security-critical: it exposes ONLY published + anonymously-viewable pages of a
// PUBLIC space — an unpublished (even public-tagged), non-public, or private page and its subtree never
// appear, and a non-public space is a uniform 404 (existence-hidden). Real Postgres + OpenFGA + Fastify.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { TenantRegistry } from '../db/registry.js'
import { acquireTenantDb } from '../db/tenant-db.js'
import type { TenantDb } from '../db/index.js'
import { fgaClient, writeTuples, deleteTuples } from '@wikistead/authz'
import { LogicalSearchDriver } from '../search/index.js'
import { createSpace, deleteSpace } from '../routes/spaces.js'
import { createPage } from '../routes/pages.js'
import { buildApp } from '../app.js'
import type { Tenant } from '@wikistead/types'

const driver = new LogicalSearchDriver()
const admin = postgres(process.env.DATABASE_ADMIN_URL!)
let tenant: Tenant, db: TenantDb, app: FastifyInstance
let pubSpace: string, otherSpace: string
let pub: string, child: string, unpub: string, nonpub: string, priv: string

// top-level published pages get a page#space + published_at; publish the id into the public space via the
// space#viewer@user:* wildcard (a public space). Each id below is created then shaped by direct tuples/SQL.
async function publish(id: string) { await admin`UPDATE pages SET published_md = 'body', published_at = now() WHERE id = ${id}` }

beforeAll(async () => {
  tenant = (await new TenantRegistry(pool).findBySlug('dev'))!
  db = await acquireTenantDb(tenant)
  pubSpace = (await createSpace(db, fgaClient, { tenantId: tenant.id, userId: 'dev-user', plan: tenant.plan, name: 'pub-space-227' })).id
  otherSpace = (await createSpace(db, fgaClient, { tenantId: tenant.id, userId: 'dev-user', plan: tenant.plan, name: 'nonpub-space-227' })).id
  const mk = async (space: string, parent: string | null, title: string) => (await createPage(db, fgaClient, driver, { tenantId: tenant.id, spaceId: space, userId: 'dev-user', title, parentId: parent })).id
  pub = await mk(pubSpace, null, 'Public Root')
  child = await mk(pubSpace, pub, 'Public Child')
  unpub = await mk(pubSpace, null, 'Public but Unpublished')
  nonpub = await mk(pubSpace, null, 'Not Public')
  priv = await mk(pubSpace, null, 'Private')
  await publish(pub); await publish(child); await publish(nonpub); await publish(priv) // unpub stays a draft
  // Make pubSpace a PUBLIC space (anonymous viewer) + page#space so pages inherit anon view.
  await writeTuples(fgaClient, [
    { user: 'user:*', relation: 'viewer', object: `space:${pubSpace}` },
    { user: `space:${pubSpace}`, relation: 'space', object: `page:${pub}` },
    { user: `space:${pubSpace}`, relation: 'space', object: `page:${child}` },
    { user: `space:${pubSpace}`, relation: 'space', object: `page:${unpub}` }, // published-flag NULL → hidden anyway
    { user: `space:${pubSpace}`, relation: 'space', object: `page:${priv}` },
    // nonpub: NO page#space → not anon-viewable even in a public space (a draft-only release path).
    // priv: private markers cut the space-viewer inheritance → not anon-viewable.
    { user: 'user:*', relation: 'private', object: `page:${priv}` },
    { user: 'share_link:*', relation: 'private', object: `page:${priv}` },
  ])
  app = await buildApp(); await app.ready()
}, 60_000)

afterAll(async () => {
  await app.close()
  await deleteTuples(fgaClient, [
    { user: 'user:*', relation: 'viewer', object: `space:${pubSpace}` },
    { user: `space:${pubSpace}`, relation: 'space', object: `page:${pub}` },
    { user: `space:${pubSpace}`, relation: 'space', object: `page:${child}` },
    { user: `space:${pubSpace}`, relation: 'space', object: `page:${unpub}` },
    { user: `space:${pubSpace}`, relation: 'space', object: `page:${priv}` },
    { user: 'user:*', relation: 'private', object: `page:${priv}` },
    { user: 'share_link:*', relation: 'private', object: `page:${priv}` },
  ]).catch(() => {})
  await deleteSpace(db, fgaClient, driver, { tenantId: tenant.id, spaceId: pubSpace, userId: 'dev-user' }).catch(() => {})
  await deleteSpace(db, fgaClient, driver, { tenantId: tenant.id, spaceId: otherSpace, userId: 'dev-user' }).catch(() => {})
  await db.release(); await pool.end(); await admin.end()
}, 60_000)

const flatIds = (tree: { id: string; children: unknown[] }[]): string[] =>
  tree.flatMap((n) => [n.id, ...flatIds((n.children as { id: string; children: unknown[] }[]) ?? [])])

describe('#227 space-level public tree', () => {
  it('lists the published+public root and its public child; omits unpublished / non-public / private', async () => {
    const res = await app.inject({ method: 'GET', url: `/public/spaces/${pubSpace}/pages`, headers: { host: 'dev.localhost' } })
    expect(res.statusCode).toBe(200)
    const ids = flatIds(res.json() as { id: string; children: unknown[] }[])
    expect(ids).toContain(pub)
    expect(ids).toContain(child)     // public subtree traversed
    expect(ids).not.toContain(unpub) // published_at NULL → absent (title/existence hidden)
    expect(ids).not.toContain(nonpub) // no page#space → not anon-viewable
    expect(ids).not.toContain(priv)  // private markers cut anon view
  })

  it('a NON-public space is a uniform 404 (existence-hidden)', async () => {
    const res = await app.inject({ method: 'GET', url: `/public/spaces/${otherSpace}/pages`, headers: { host: 'dev.localhost' } })
    expect(res.statusCode).toBe(404)
  })
})
