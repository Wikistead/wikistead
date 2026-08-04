// #514 / ADR-188 §6, the gate that must exist BEFORE the unification. Built-in space roles are granted
// through one path (spaces.ts CAP_TO_RELATION → a single relation leaf) and custom roles through another
// (roles.ts expansionTuples → the capability bundle). §6 folds the first into the second — and the design
// review caught what makes that dangerous: `manager` is NOT a capability bundle. It is a superset LEAF
// (ROLE_CAPABILITIES has no `manage`, and the built-in manager bundle does not even list `moderate`), so a
// naive "expand manager into its listed capabilities" would silently drop space manage, page
// manage_from_space and moderator from every manager grant.
//
// These pin what a manager grant RESOLVES TO today, per the ADR's mandatory manager→manage and
// manager→moderate equivalences. They are written against the current direct-grant path so the unification
// has something to be equivalent TO: if the folded path ever stops conferring one of these, this goes red
// rather than the loss being discovered by a user who can no longer manage their own space.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { pool } from '../db/pool.js'
import { TenantRegistry } from '../db/registry.js'
import { acquireTenantDb } from '../db/tenant-db.js'
import type { TenantDb } from '../db/index.js'
import { fgaClient, check, deleteTuples } from '@wikistead/authz'
import { LogicalSearchDriver } from '../search/index.js'
import { createSpace, deleteSpace, grantSpaceAccess, revokeSpaceAccess } from '../routes/spaces.js'
import { createPage, deletePage, publishPage } from '../routes/pages.js'
import type { Tenant } from '@wikistead/types'

const driver = new LogicalSearchDriver()
const OWNER = 'dev-user'
const GRANTEE = `builtin-mgr-${Date.now().toString(36)}`
// One grantee per built-in capability: grants accumulate on a principal, so sharing one would let an
// earlier grant answer a later assertion and every case after the first would pass for free.
const STAMP = Date.now().toString(36)
const BY_CAP: Record<'view' | 'comment' | 'edit' | 'moderate' | 'manageAccess', string> = {
  view: `builtin-view-${STAMP}`,
  comment: `builtin-comment-${STAMP}`,
  edit: `builtin-edit-${STAMP}`,
  moderate: `builtin-moderate-${STAMP}`,
  manageAccess: `builtin-mgacc-${STAMP}`, // ADR-209 (#607): the verb IS a built-in grant, so it is measured here
}

let tenant: Tenant
let db: TenantDb
let spaceId: string
let pageId: string

beforeAll(async () => {
  tenant = (await new TenantRegistry(pool).findBySlug('dev'))!
  db = await acquireTenantDb(tenant)
  spaceId = (await createSpace(db, fgaClient, { tenantId: tenant.id, userId: OWNER, plan: tenant.plan, name: 'builtin-equiv-514' })).id
  const p = await createPage(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: OWNER, title: 'managed' })
  pageId = p.id
  await publishPage(db, fgaClient, driver, { putObject: async () => {}, getObject: async () => Buffer.alloc(0) } as never, {
    pageId, subject: `user:${OWNER}`, createdBy: `user:${OWNER}`,
  })
}, 120_000)

afterAll(async () => {
  await deleteTuples(fgaClient, [{ user: `user:${GRANTEE}`, relation: 'manager', object: `space:${spaceId}` }]).catch(() => {})
  for (const [cap, sub] of Object.entries(BY_CAP)) {
    const { spaceGrantTuplesFor } = await import('../space-grant-expansion.js')
    await deleteTuples(fgaClient, spaceGrantTuplesFor(`user:${sub}`, cap, spaceId)).catch(() => {})
  }
  await deletePage(db, fgaClient, driver, { pageId, userId: OWNER }).catch(() => {})
  await deleteSpace(db, fgaClient, driver, { tenantId: tenant.id, spaceId, userId: OWNER }).catch(() => {})
  await db.release()
  await pool.end()
}, 120_000)

describe('#514 §6 — what a built-in `manager` grant confers (the equivalence the unification must preserve)', () => {
  it('confers space MANAGE and MODERATE, neither of which appears in the built-in capability list', async () => {
    const sub = `user:${GRANTEE}`
    expect(await check(fgaClient, sub, 'manage', { type: 'space', id: spaceId }), 'nothing before the grant').toBe(false)

    await grantSpaceAccess(db, fgaClient, driver, {
      spaceId, tenantId: tenant.id, userId: OWNER, grantee: sub, capability: 'manage', plan: tenant.plan,
    })

    // the two the ADR names as mandatory — both come from the `manager` LEAF, not from any listed capability
    expect(await check(fgaClient, sub, 'manage', { type: 'space', id: spaceId }), 'manager ⇒ space manage').toBe(true)
    expect(await check(fgaClient, sub, 'moderate', { type: 'space', id: spaceId }), 'manager ⇒ moderate (absent from the bundle)').toBe(true)
    // …and it reaches the space's pages, which is what a "manager" is for
    expect(await check(fgaClient, sub, 'manage', { type: 'page', id: pageId }), 'manager ⇒ page manage_from_space').toBe(true)
  }, 120_000)

  it('the listed capabilities resolve too — the superset really is a superset', async () => {
    const sub = `user:${GRANTEE}`
    // Space-level verbs only — `comment` is a PAGE verb (the space type carries the `commenter` grantee
    // relation that pages inherit from, not a `comment` verb of its own), so it is asserted below.
    for (const verb of ['view', 'edit'] as const) {
      expect(await check(fgaClient, sub, verb, { type: 'space', id: spaceId }), `manager ⇒ space ${verb}`).toBe(true)
    }
    for (const verb of ['view', 'edit', 'comment', 'publish', 'delete'] as const) {
      expect(await check(fgaClient, sub, verb, { type: 'page', id: pageId }), `manager ⇒ page ${verb}`).toBe(true)
    }
  }, 120_000)
})

// #514 §6: the two paths now share ONE capability→relation table (space-grant-expansion.ts). That table
// carries `manage`, because the built-in grant needs it — so the invariant that a CUSTOM role can never
// request it has to be pinned on the vocabulary, not on the table's absence.
describe('#514 §6 — sharing the table does not let a custom role ask for `manage`', () => {
  it('`manage` is absent from the custom-role vocabulary', async () => {
    const { ROLE_CAPABILITIES } = await import('../routes/roles.js')
    expect([...ROLE_CAPABILITIES], 'a custom bundle lists the atoms; manage is the built-in superset')
      .not.toContain('manage')
  })

  it('…while the shared table still expands it to the single `manager` leaf (never the bundle)', async () => {
    const { spaceGrantTuplesFor } = await import('../space-grant-expansion.js')
    const tuples = spaceGrantTuplesFor('user:probe', 'manage', 'space-probe')
    expect(tuples.map((t) => t.relation), 'one leaf, not an expansion').toEqual(['manager'])
  })

  it('and a view grant still writes the #258 pair from that same table', async () => {
    const { spaceGrantTuplesFor } = await import('../space-grant-expansion.js')
    expect(spaceGrantTuplesFor('user:probe', 'view', 'space-probe').map((t) => t.relation))
      .toEqual(['viewer', 'viewer_member'])
  })
})

// #536 / ADR-188 §6: the SAME equivalence, for every OTHER built-in. The manager case above exists because
// it is the dangerous one (a superset leaf that a naive expansion would strip); these exist because the
// unification has to preserve the quiet ones too, and "quiet" is exactly what nobody re-checks. Each pins
// what a built-in grant RESOLVES TO today — including the verbs the model confers WITHOUT listing them —
// so folding the built-in path into the role mechanism has a target to be check-equivalent to.
describe('#536 §6 — what every other built-in grant confers today', () => {
  const grant = async (capability: 'view' | 'comment' | 'edit' | 'moderate' | 'manageAccess') =>
    grantSpaceAccess(db, fgaClient, driver, {
      spaceId, tenantId: tenant.id, userId: OWNER, grantee: `user:${BY_CAP[capability]}`, capability, plan: tenant.plan,
    })

  it('viewer: reads the space and its published pages, and nothing more', async () => {
    const sub = `user:${BY_CAP.view}`
    expect(await check(fgaClient, sub, 'view', { type: 'space', id: spaceId }), 'nothing before').toBe(false)
    await grant('view')
    expect(await check(fgaClient, sub, 'view', { type: 'space', id: spaceId })).toBe(true)
    expect(await check(fgaClient, sub, 'view', { type: 'page', id: pageId }), 'reaches the space pages').toBe(true)
    // The boundary is the point: a reader must not gain the write verbs by being a reader.
    for (const verb of ['edit', 'publish', 'delete', 'share', 'settings', 'manage'] as const) {
      expect(await check(fgaClient, sub, verb, { type: 'page', id: pageId }), `viewer does NOT get page ${verb}`).toBe(false)
    }
    expect(await check(fgaClient, sub, 'moderate', { type: 'space', id: spaceId }), 'nor moderation').toBe(false)
  }, 120_000)

  it('access-manager: sees the space, runs no verb but its own (ADR-209)', async () => {
    const sub = `user:${BY_CAP.manageAccess}`
    expect(await check(fgaClient, sub, 'manageAccess', { type: 'space', id: spaceId }), 'nothing before').toBe(false)
    await grant('manageAccess')
    expect(await check(fgaClient, sub, 'manageAccess', { type: 'space', id: spaceId })).toBe(true)
    expect(await check(fgaClient, sub, 'view', { type: 'space', id: spaceId }), 'the viewer arm — the roster is visible').toBe(true)
    expect(await check(fgaClient, sub, 'view', { type: 'page', id: pageId }), 'and so are the published pages').toBe(true)
    for (const verb of ['edit', 'publish', 'delete', 'share', 'settings', 'manage'] as const) {
      expect(await check(fgaClient, sub, verb, { type: 'page', id: pageId }), `access-manager does NOT get page ${verb}`).toBe(false)
    }
    expect(await check(fgaClient, sub, 'manage', { type: 'space', id: spaceId }), 'and never the space').toBe(false)
  }, 120_000)

  it('commenter: comments on the space pages without gaining edit (#529)', async () => {
    const sub = `user:${BY_CAP.comment}`
    await grant('comment')
    expect(await check(fgaClient, sub, 'comment', { type: 'page', id: pageId }), 'the per-principal leaf pages inherit').toBe(true)
    expect(await check(fgaClient, sub, 'view', { type: 'page', id: pageId }), 'comment implies view').toBe(true)
    expect(await check(fgaClient, sub, 'edit', { type: 'page', id: pageId }), 'but NOT edit').toBe(false)
  }, 120_000)

  // #553 / ADR-199: this pin SPLIT deliberately. The old single test asserted `edit subsumes comment`
  // (the model implication #553 removed); the intent survives as a pair — the editor NOUN (the
  // composite) still delivers comment, while the bare `edit` capability grants exactly what it says.
  it('editor NOUN (the composite): edits AND comments — the bundle delivers what the noun promises', async () => {
    const sub = `user:${BY_CAP.edit}`
    const { spaceGrantTuplesFor } = await import('../space-grant-expansion.js')
    expect(spaceGrantTuplesFor(sub, 'edit', spaceId).map((t) => t.relation), 'the edit table is untouched').toEqual(['editor_member'])
    const { grantSpaceAccessComposite } = await import('../routes/spaces.js')
    await grantSpaceAccessComposite(db, fgaClient, driver, {
      spaceId, tenantId: tenant.id, userId: OWNER, grantee: sub, capabilities: ['edit', 'comment'], plan: tenant.plan,
    })
    expect(await check(fgaClient, sub, 'edit', { type: 'page', id: pageId })).toBe(true)
    expect(await check(fgaClient, sub, 'comment', { type: 'page', id: pageId }), 'the composite delivers comment explicitly').toBe(true)
    expect(await check(fgaClient, sub, 'view', { type: 'page', id: pageId })).toBe(true)
    expect(await check(fgaClient, sub, 'manage', { type: 'page', id: pageId }), 'an editor is not a manager').toBe(false)
    expect(await check(fgaClient, sub, 'moderate', { type: 'space', id: spaceId }), 'nor a moderator').toBe(false)
  }, 120_000)

  it('bare edit capability: edits, does NOT comment (#553 — the severed subsumption)', async () => {
    const sub = `user:bare-edit-514-${Date.now().toString(36)}`
    await grantSpaceAccess(db, fgaClient, driver, {
      spaceId, tenantId: tenant.id, userId: OWNER, grantee: sub, capability: 'edit', plan: tenant.plan,
    })
    expect(await check(fgaClient, sub, 'edit', { type: 'page', id: pageId })).toBe(true)
    expect(await check(fgaClient, sub, 'comment', { type: 'page', id: pageId }), 'bare edit grants exactly edit').toBe(false)
  }, 120_000)

  it('moderator: moderates and gains the comment the model gives it, but not edit-by-right', async () => {
    const sub = `user:${BY_CAP.moderate}`
    await grant('moderate')
    expect(await check(fgaClient, sub, 'moderate', { type: 'space', id: spaceId })).toBe(true)
    // #330: moderate reaches comment through the model (moderate → comment), which is precisely the kind of
    // conferred-but-unlisted verb the manager case showed an expansion can destroy.
    expect(await check(fgaClient, sub, 'comment', { type: 'page', id: pageId }), 'moderate ⇒ comment').toBe(true)
    expect(await check(fgaClient, sub, 'manage', { type: 'space', id: spaceId }), 'a moderator is not a manager').toBe(false)
  }, 120_000)
})

// #536 grant and revoke must be each other's inverse. The equivalences above only look at what a
// grant CONFERS — and an expansion that writes more leaves than the revoke deletes passes every one of
// them while leaving access behind after it is taken away. That asymmetry is exactly what routing built-in
// grants through the bundle mechanism (§6, still open) would introduce if nothing watched for it, so the
// round trip is pinned BEFORE that move rather than after someone notices a revoked member still reading.
describe('#536 §6 — revoking a built-in grant leaves nothing behind', () => {
  const REVOKE_STAMP = Date.now().toString(36)
  const subFor = (cap: string) => `user:builtin-rev-${cap}-${REVOKE_STAMP}`

  it.each(['view', 'comment', 'edit', 'moderate', 'manage'] as const)(
    'a %s grant, revoked, confers nothing it conferred', async (capability) => {
      const sub = subFor(capability)
      await grantSpaceAccess(db, fgaClient, driver, {
        spaceId, tenantId: tenant.id, userId: OWNER, grantee: sub, capability, plan: tenant.plan,
      })
      // Non-vacuity: the grant really landed, so the emptiness below is the revoke's doing and not the
      // grant having quietly failed.
      const conferred = capability === 'moderate'
        ? await check(fgaClient, sub, 'moderate', { type: 'space', id: spaceId })
        : await check(fgaClient, sub, 'view', { type: 'page', id: pageId })
      expect(conferred, `the ${capability} grant landed first`).toBe(true)

      await revokeSpaceAccess(db, fgaClient, driver, {
        spaceId, tenantId: tenant.id, userId: OWNER, grantee: sub, capability, plan: tenant.plan,
      })

      // Every verb, not just the one named: a bundle expansion that writes extra leaves would leave the
      // EXTRAS behind, and checking only the granted verb would report a clean revoke.
      for (const verb of ['view', 'comment', 'edit', 'publish', 'delete', 'share', 'settings', 'manage'] as const) {
        expect(await check(fgaClient, sub, verb, { type: 'page', id: pageId }), `page ${verb} is gone`).toBe(false)
      }
      for (const verb of ['view', 'edit', 'moderate', 'manage'] as const) {
        expect(await check(fgaClient, sub, verb, { type: 'space', id: spaceId }), `space ${verb} is gone`).toBe(false)
      }
    }, 120_000)
})
