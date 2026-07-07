// #230: backlinks — pages that reference a target page from their PUBLISHED content, via a persisted
// reference (an /p/<id> link or an :::embed-page body). Each backlink is FGA-view-gated for the
// caller, so a reference from a page the viewer cannot see is never leaked. Real Postgres + OpenFGA.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { TenantRegistry } from '../db/registry.js'
import { acquireTenantDb } from '../db/tenant-db.js'
import type { TenantDb } from '../db/index.js'
import { fgaClient, writeTuples, deleteTuples } from '@wikistead/authz'
import { LogicalSearchDriver } from '../search/index.js'
import { createSpace, deleteSpace } from '../routes/spaces.js'
import { createPage, deletePage, getBacklinks } from '../routes/pages.js'
import type { Tenant } from '@wikistead/types'

const driver = new LogicalSearchDriver()
const adminPool = postgres(process.env.DATABASE_ADMIN_URL!)

let tenant: Tenant
let db: TenantDb
let spaceId: string
const ids: string[] = []
let target!: string
let linker!: string   // links via /p/<target>
let embedder!: string // references via :::embed-page
let hidden!: string   // links to target but the viewer can't see this page
let unrelated!: string

async function mkPage(title: string, md: string | null): Promise<string> {
  const p = await createPage(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user', title })
  ids.push(p.id)
  if (md !== null) await adminPool`UPDATE pages SET published_md = ${md}, published_at = now() WHERE id = ${p.id}`
  return p.id
}

beforeAll(async () => {
  const registry = new TenantRegistry(pool)
  tenant = (await registry.findBySlug('dev'))!
  db = await acquireTenantDb(tenant)
  const space = await createSpace(db, fgaClient, { tenantId: tenant.id, userId: 'dev-user', plan: tenant.plan, name: 'backlinks-space' })
  spaceId = space.id
  target = await mkPage('Target', 'target body')
  linker = await mkPage('Linker', `see [the target](/p/${target}) for details`)
  embedder = await mkPage('Embedder', `intro\n\n:::embed-page\n${target}\n:::\n\nmore`)
  hidden = await mkPage('Hidden', `secretly links [x](/p/${target})`)
  unrelated = await mkPage('Unrelated', 'mentions nothing relevant')
}, 60_000)

afterAll(async () => {
  for (const id of ids) await deletePage(db, fgaClient, driver, { pageId: id, userId: 'dev-user' }).catch(() => {})
  await deleteSpace(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: 'dev-user' }).catch(() => {})
  await db.release()
  await pool.end()
  await adminPool.end()
}, 60_000)

describe('getBacklinks (#230)', () => {
  it('finds pages that link via /p/<id> AND via :::embed-page, and not unrelated pages', async () => {
    const links = await getBacklinks(db, fgaClient, { pageId: target, subject: 'user:dev-user' })
    const foundIds = links.map((l) => l.id).sort()
    expect(foundIds).toContain(linker)
    expect(foundIds).toContain(embedder)
    expect(foundIds).not.toContain(unrelated)
    expect(links.find((l) => l.id === linker)?.title).toBe('Linker')
  })

  it('does NOT return the target itself', async () => {
    const links = await getBacklinks(db, fgaClient, { pageId: target, subject: 'user:dev-user' })
    expect(links.map((l) => l.id)).not.toContain(target)
  })

  it('a substring-only mention is NOT a backlink (precise reference, not LIKE noise)', async () => {
    // A page whose body contains the id as a bare substring (not an /p/ link nor an embed-page body).
    const noise = await mkPage('Noise', `the string ${target} appears mid-sentence but is not a link`)
    const links = await getBacklinks(db, fgaClient, { pageId: target, subject: 'user:dev-user' })
    expect(links.map((l) => l.id)).not.toContain(noise)
  })

  it('authz: a backlink from a page the viewer CANNOT see is not leaked', async () => {
    // `hidden` links to target but is private (creator-only). A different member must not see it.
    const asOther = await getBacklinks(db, fgaClient, { pageId: target, subject: 'user:other-member' })
    expect(asOther.map((l) => l.id)).not.toContain(hidden)
    // ...while the creator (who can view it) DOES get it.
    const asCreator = await getBacklinks(db, fgaClient, { pageId: target, subject: 'user:dev-user' })
    expect(asCreator.map((l) => l.id)).toContain(hidden)
  })
})
