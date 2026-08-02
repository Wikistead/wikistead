// #586 / ADR-203 §4: the list a tooltip shows is what the model actually confers.
//
// The point of the feature is to replace a hedge ("editors can also comment") with the facts, and the
// worst possible landing is to replace it with a CONFIDENT FALSEHOOD. `BUILT_IN_ROLES` is wrong in three
// places — `manager` is declared without `manage` or `moderate`, `moderator` as `moderate` alone, and a
// legacy single-arm `edit` grant renders as `editor` while carrying no `comment` — because those verbs
// arrive through model leaves rather than through the grant. The Roles tab renders that declaration
// today, so one of those errors is already on screen.
//
// Reading `model.fga` as text cannot settle it either: `manager ⊃ moderate` and a moderator's page
// `edit` are closures through leaves and a bypass, not lines in the file. So this measures — grant each
// noun in a REAL OpenFGA store, read back every verb it resolves to on a real page — and compares the
// answer with the table the UI renders. Same method as builtin-grant-equivalence-514, which is where the
// `manage` superset-leaf fact came from in the first place.
//
// When the model changes, this fails with the measured set in the message: the table in the web source
// is a cache of this store's answer, and this test is the thing that keeps it a cache rather than a
// belief.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { acquireTenantDb, type TenantDb } from '../db/index.js'
import { fgaClient, check } from '@wikistead/authz'
import { createSpace, deleteSpace, grantSpaceAccess, grantSpaceAccessComposite } from '../routes/spaces.js'
import { createPage, deletePage, publishPage } from '../routes/pages.js'
import { buildApp } from '../app.js'
import type { FastifyInstance } from 'fastify'
import type { Tenant } from '@wikistead/types'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const TENANT = 'tenant_dev'
const asTenant = (id: string): Tenant => ({ id, slug: id, plan: 'business', isolation: 'logical' }) as Tenant
const STAMP = Date.now().toString(36)
const OWNER = 'dev-user'

let app: FastifyInstance
let db: TenantDb
let spaceId = ''
let pageId = ''

beforeAll(async () => {
  app = await buildApp(); await app.ready()
  db = await acquireTenantDb(asTenant(TENANT))
  spaceId = (await createSpace(db, fgaClient, { tenantId: TENANT, userId: OWNER, plan: 'business', name: `caps586-${STAMP}` })).id
  pageId = (await createPage(db, fgaClient, app.searchDriver, { tenantId: TENANT, spaceId, userId: OWNER, title: `caps586-${STAMP}` })).id
  await publishPage(db, fgaClient, app.searchDriver, app.storageDriver, { pageId, subject: `user:${OWNER}`, createdBy: `user:${OWNER}` })
}, 180_000)

afterAll(async () => {
  await admin`DELETE FROM role_assignments WHERE resource_id = ${spaceId}`.catch(() => {})
  await deletePage(db, fgaClient, app.searchDriver, { pageId, userId: OWNER }).catch(() => {})
  await deleteSpace(db, fgaClient, app.searchDriver, { tenantId: TENANT, spaceId, userId: OWNER }).catch(() => {})
  await db.release(); await app.close(); await admin.end(); await pool.end()
}, 180_000)

/** Every page verb worth listing to a human, in the order the UI shows them. */
const VERBS = ['view', 'comment', 'edit', 'moderate', 'publish', 'delete', 'share', 'manage'] as const

/** The table the UI renders, read from the web source (one table, two readers — never two tables). */
function uiTable(): Record<string, string[]> {
  const src = readFileSync(resolve(import.meta.dirname, '../../../web/src/settings/role-nouns.ts'), 'utf8')
  const block = /BUILTIN_EFFECTIVE_CAPS[^=]*=\s*\{([\s\S]*?)\n\};/.exec(src)?.[1]
  expect(block, 'the web table is where this test says it is').toBeTruthy()
  const out: Record<string, string[]> = {}
  for (const m of block!.matchAll(/(\w+):\s*\[([^\]]*)\]/g)) {
    out[m[1]!] = [...m[2]!.matchAll(/"([a-z]+)"/g)].map((c) => c[1]!)
  }
  return out
}

/** What a principal holding `noun` really resolves to on a page of that space. */
async function measured(noun: 'view' | 'comment' | 'edit' | 'moderate' | 'manage'): Promise<string[]> {
  const sub = `user:caps586-${noun}-${STAMP}`
  if (noun === 'edit') {
    // the editor NOUN is the composite (#553 severed the edit ⇒ comment implication, so the bundle is
    // what makes an "editor" able to comment — a bare edit grant is a different, narrower thing)
    await grantSpaceAccessComposite(db, fgaClient, app.searchDriver, {
      spaceId, tenantId: TENANT, userId: OWNER, grantee: sub, capabilities: ['edit', 'comment'], plan: 'business',
    })
  } else {
    await grantSpaceAccess(db, fgaClient, app.searchDriver, { spaceId, tenantId: TENANT, userId: OWNER, grantee: sub, capability: noun, plan: 'business' })
  }
  const held: string[] = []
  for (const v of VERBS) if (await check(fgaClient, sub, v, { type: 'page', id: pageId })) held.push(v)
  return held
}

describe('#586: the built-in display table is the store\'s answer', () => {
  it.each(['view', 'comment', 'edit', 'moderate', 'manage'] as const)(
    '%s lists exactly what it confers', async (noun) => {
      const held = await measured(noun)
      expect(uiTable()[noun], `the UI table for ${noun} is stale — the store says [${held.join(', ')}]`).toEqual(held)
    }, 180_000)

  it('and the three facts a static bundle gets wrong are in it', async () => {
    const table = uiTable()
    // Each of these was WRONG in BUILT_IN_ROLES, and each is why the table is measured rather than typed.
    expect(table.manage, 'a manager moderates, though the bundle never says so').toContain('moderate')
    expect(table.manage, 'and manages').toContain('manage')
    expect(table.moderate, 'a moderator comments (#330: moderate ⇒ comment)').toContain('comment')
    expect(table.moderate, 'and edits a page through the moderation bypass').toContain('edit')
    expect(table.edit, 'the editor NOUN comments; the bare capability does not (#553)').toContain('comment')
  }, 60_000)

  it('a bare edit grant is NOT the editor noun — the row must not claim comment for it', async () => {
    // The legacy single-arm case: pre-#553 grants that wear the `editor` badge with no comment arm.
    // The display set for a ROW comes from what the row holds, which is why the client joins on the
    // row's own capabilities rather than looking the badge up by name.
    const sub = `user:caps586-bare-${STAMP}`
    await grantSpaceAccess(db, fgaClient, app.searchDriver, { spaceId, tenantId: TENANT, userId: OWNER, grantee: sub, capability: 'edit', plan: 'business' })
    expect(await check(fgaClient, sub, 'edit', { type: 'page', id: pageId })).toBe(true)
    expect(await check(fgaClient, sub, 'comment', { type: 'page', id: pageId }), 'a bare edit grant grants exactly edit').toBe(false)
  }, 180_000)
})
