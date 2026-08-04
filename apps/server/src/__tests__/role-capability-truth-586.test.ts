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
import { createPage, deletePage, publishPage, grantPageAccess } from '../routes/pages.js'
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
// #586`settings` joined the list — the grid draws a settings column, and the measured tables
// lacked the verb entirely, so a space manager (who settles pages via `page#settings: manage or …`)
// showed settings unticked. A column the measurement does not cover is a lie waiting to be drawn.
const VERBS = ['view', 'comment', 'edit', 'moderate', 'publish', 'delete', 'share', 'settings', 'manage'] as const

/** A table the UI renders, read from the web source (one table, two readers — never two tables). */
function uiTable(name = 'BUILTIN_EFFECTIVE_CAPS'): Record<string, string[]> {
  const src = readFileSync(resolve(import.meta.dirname, '../../../web/src/settings/role-nouns.ts'), 'utf8')
  const block = new RegExp(`${name}[^=]*=\\s*\\{([\\s\\S]*?)\\n\\};`).exec(src)?.[1]
  expect(block, `the web table ${name} is where this test says it is`).toBeTruthy()
  const out: Record<string, string[]> = {}
  for (const m of block!.matchAll(/(\w+):\s*\[([^\]]*)\]/g)) {
    // [a-zA-Z]: the tenant vocabulary is camelCase ("createSpaces"), and a lowercase-only pattern read
    // that table as empty — an empty parse compares as "confers nothing", which is a silent lie
    out[m[1]!] = [...m[2]!.matchAll(/"([a-zA-Z]+)"/g)].map((c) => c[1]!)
  }
  return out
}

/** What a principal holding `noun` really resolves to on a page of that space. */
async function measured(noun: 'view' | 'comment' | 'edit' | 'moderate' | 'manage' | 'manageAccess'): Promise<string[]> {
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
  // #607 bounce: the row is REFLEXIVE — the noun's own verb, measured on the SPACE axis where
  // the grant lives. The page loop cannot see a space-only verb, which is how the role that exists to
  // hand out membership (`manageAccess`) drew as view-only, indistinguishable from `viewer` in the very
  // picker that hands it out. Read back from the store, not assumed: a noun whose grant does not answer
  // its own check would be a modelling bug this line surfaces.
  if (!held.includes(noun) && (await check(fgaClient, sub, noun, { type: 'space', id: spaceId }))) held.push(noun)
  return held
}

/**
 * What a BARE page grant of `relation` confers on that page.
 *
 * Different from the noun above, and the difference is the defect this measures. A space grant of the
 * editor NOUN writes a composite (#553 severed edit ⇒ comment, so the bundle is what lets an editor
 * comment). A page grant writes ONE capability — `grantPageAccess` passes `capabilities: [relation]` —
 * so the page dialog's rows are single arms, every one of them, not only the legacy ones. Looking their
 * badge up in the noun table told a reader that a page `edit` grant could comment, which the store
 * denies.
 */
async function measuredPageGrant(relation: 'view' | 'comment' | 'edit' | 'moderate' | 'manage'): Promise<string[]> {
  const sub = `user:caps586-pg-${relation}-${STAMP}`
  await grantPageAccess(db, fgaClient, app.searchDriver, {
    pageId, tenantId: TENANT, userId: OWNER, grantee: sub, relation, plan: 'business',
  })
  const held: string[] = []
  for (const v of VERBS) if (await check(fgaClient, sub, v, { type: 'page', id: pageId })) held.push(v)
  return held
}

describe('#586 review ①: a page grant is a single arm, and says only what that arm confers', () => {
  it.each(['view', 'comment', 'edit', 'moderate', 'manage'] as const)(
    'a page grant of %s lists exactly what it confers', async (relation) => {
      const held = await measuredPageGrant(relation)
      expect(
        uiTable('PAGE_GRANT_CAPS')[relation],
        `the UI table for a page ${relation} grant is stale — the store says [${held.join(', ')}]`,
      ).toEqual(held)
    }, 180_000)

  it('the two tables DIFFER, which is why there are two of them', async () => {
    // If they were ever equal, one of them would be redundant and the next person would delete the
    // wrong one. The edit row is the case the review caught: the noun comments, the arm does not.
    expect(uiTable('PAGE_GRANT_CAPS').edit, 'a page edit grant does not confer comment (#553)').not.toContain('comment')
    expect(uiTable().edit, 'the editor noun does').toContain('comment')
  })
})

describe('#586: the built-in display table is the store\'s answer', () => {
  it.each(['view', 'comment', 'edit', 'moderate', 'manage', 'manageAccess'] as const)(
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

  // ADR-209 (#607): the SPACE-verb axis for the membership verb — the page-verb rows above cannot see
  // a space gate at all, so the verb's own grain is measured against {type:'space'} directly.
  it('access-manager runs the roster and nothing else (space axis)', async () => {
    const sub = `user:caps586-am-${STAMP}`
    await grantSpaceAccess(db, fgaClient, app.searchDriver, { spaceId, tenantId: TENANT, userId: OWNER, grantee: sub, capability: 'manageAccess', plan: 'business' })
    expect(await check(fgaClient, sub, 'manageAccess', { type: 'space', id: spaceId }), 'holds the verb').toBe(true)
    expect(await check(fgaClient, sub, 'view', { type: 'space', id: spaceId }), 'sees the space (the viewer arm)').toBe(true)
    expect(await check(fgaClient, sub, 'manage', { type: 'space', id: spaceId }), 'does NOT hold the space').toBe(false)
    expect(await check(fgaClient, sub, 'edit', { type: 'space', id: spaceId }), 'does not edit').toBe(false)
    expect(await check(fgaClient, sub, 'moderate', { type: 'space', id: spaceId }), 'does not moderate').toBe(false)
    // …and a MANAGER holds the verb through `or manager` — additive, nobody lost an answer
    expect(await check(fgaClient, `user:${OWNER}`, 'manageAccess', { type: 'space', id: spaceId }), 'a manager passes the new gate').toBe(true)
  }, 180_000)

  //the asymmetry the reviewer caught — `manage` reflexive, `manageAccess` not — sat inside the
  // table while every pin stayed green, because no scan asked the question. This one does, over the
  // WHOLE vocabulary rather than the row that happened to be wrong; the store's agreement is enforced
  // by the it.each above (the row equals the measured closure, which now carries the reflexive verb).
  it('every closure row contains its own capability (reflexivity,)', () => {
    const table = uiTable()
    for (const [noun, caps] of Object.entries(table)) {
      expect(caps, `${noun}: a role's window must say what the role IS, not only what rides along`).toContain(noun)
    }
  })

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

// #586①: the TENANT tiers.ruled "no tooltip without a measured table", and there was no
// table because there was nothing to measure — the tiers had two independent leaves. #604 changed the
// premise: three verbs were carved out of `admin` as `… or admin` unions, so what `admin` confers is a
// CLOSURE again, and the roles list was still drawing the two-leaf declaration (admin with
// manageConnections/manageRoles/viewAudit unticked while a real store answers true for all three).
describe('#586the tenant tier table is the store\'s answer', () => {
  const TENANT_VERBS: Record<string, string> = {
    createSpaces: 'space_creator', issueApiKeys: 'api_key_issue',
    manageConnections: 'manage_connections', manageRoles: 'manage_roles', viewAudit: 'view_audit',
  }
  const measure = async (tier: 'admin' | 'member') => {
    const sub = `user:caps586-tier-${tier}-${STAMP}`
    const { writeTuples, deleteTuples } = await import('@wikistead/authz')
    await writeTuples(fgaClient, [{ user: sub, relation: tier, object: `tenant:${TENANT}` }])
    const held: string[] = []
    try {
      for (const [cap, rel] of Object.entries(TENANT_VERBS)) {
        const { allowed } = await fgaClient.check({ user: sub, relation: rel, object: `tenant:${TENANT}` })
        if (allowed) held.push(cap)
      }
    } finally {
      await deleteTuples(fgaClient, [{ user: sub, relation: tier, object: `tenant:${TENANT}` }]).catch(() => {})
    }
    return held
  }
  it('admin lists exactly what the store confers', async () => {
    const held = await measure('admin')
    expect(uiTable('TENANT_TIER_CAPS').admin, `the UI table for the admin tier is stale — the store says [${held.join(', ')}]`).toEqual(held)
  }, 180_000)
  it('member confers none of the tenant verbs by tier alone', async () => {
    const held = await measure('member')
    expect(uiTable('TENANT_TIER_CAPS').member, `the UI table for the member tier is stale — the store says [${held.join(', ')}]`).toEqual(held)
  }, 180_000)
})
