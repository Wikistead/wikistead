import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import postgres from 'postgres'
import { pool } from '../db/pool.js'
import { TenantRegistry } from '../db/registry.js'
import { acquireTenantDb } from '../db/tenant-db.js'
import type { TenantDb } from '../db/index.js'
import type { Tenant } from '@wikistead/types'
import {
  fgaClient, writeTuples, deleteTuples, check, checkRelation, filterAuthorized,
  runInAuthzScope, SYSTEM_SCOPE,
  registerAuthzRestrictionEvaluator, resetAuthzRestrictionEvaluator,
} from '@wikistead/authz'
import { LogicalSearchDriver } from '../search/index.js'
import { createSpace, deleteSpace } from '../routes/spaces.js'
import { createPage, deletePage } from '../routes/pages.js'

// #637 / ADR-216 §5: the restriction ANDs with the authorization answer, at all three primitives.
//
// Both directions are measured, because each alone passes a broken implementation. Only the outward one
// ("the key cannot leave its space") and an implementation that ignores the owner's rights entirely
// passes; only the inward one ("it still cannot see what its owner cannot") and an implementation that
// ignores the restriction passes. What is being asserted is an AND, so it takes both.
//
// And all three primitives, because they are reached by different surfaces: `check` by a page read,
// `checkRelation` by the tree and the public walk, `filterAuthorized` by search stage 2 and the space
// roster. An implementation that only wires the first looks right at every place a reviewer would
// naturally click.
const driver = new LogicalSearchDriver()
const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const USER = 'user:restriction-637'

let tenant: Tenant
let db: TenantDb
let inSpace: string
let outSpace: string
let insidePage: string
let outsidePage: string
let unseenPage: string // inside the allowed space, but the OWNER cannot view it

beforeAll(async () => {
  tenant = (await new TenantRegistry(pool).findBySlug('dev'))!
  db = await acquireTenantDb(tenant)
  const a = await createSpace(db, fgaClient, { tenantId: tenant.id, userId: 'dev-user', plan: tenant.plan, name: 'restriction-in' })
  const b = await createSpace(db, fgaClient, { tenantId: tenant.id, userId: 'dev-user', plan: tenant.plan, name: 'restriction-out' })
  inSpace = a.id; outSpace = b.id
  insidePage = (await createPage(db, fgaClient, driver, { tenantId: tenant.id, spaceId: inSpace, userId: 'dev-user', title: 'inside' })).id
  outsidePage = (await createPage(db, fgaClient, driver, { tenantId: tenant.id, spaceId: outSpace, userId: 'dev-user', title: 'outside' })).id
  unseenPage = (await createPage(db, fgaClient, driver, { tenantId: tenant.id, spaceId: inSpace, userId: 'dev-user', title: 'unseen' })).id
  // the principal can view two of the three: one inside the allowed space, one outside it. `unseenPage`
  // is deliberately left ungranted — it is what proves the restriction did not become the whole answer.
  await writeTuples(fgaClient, [
    { user: USER, relation: 'view_direct', object: `page:${insidePage}` },
    { user: USER, relation: 'view_direct', object: `page:${outsidePage}` },
  ])
}, 120_000)

afterAll(async () => {
  await deleteTuples(fgaClient, [
    { user: USER, relation: 'view_direct', object: `page:${insidePage}` },
    { user: USER, relation: 'view_direct', object: `page:${outsidePage}` },
  ]).catch(() => {})
  for (const p of [insidePage, outsidePage, unseenPage]) await deletePage(db, fgaClient, driver, { pageId: p, userId: 'dev-user' }).catch(() => {})
  for (const s of [inSpace, outSpace]) await deleteSpace(db, fgaClient, driver, { tenantId: tenant.id, spaceId: s, userId: 'dev-user' }).catch(() => {})
  await db.release(); await pool.end(); await admin.end()
}, 120_000)

afterEach(() => resetAuthzRestrictionEvaluator())

/** A stand-in for the EE rule: a page is reachable when the space it lives in is on the key's list. */
function registerSpaceEvaluator() {
  registerAuthzRestrictionEvaluator(async (restriction, resource) => {
    if (resource.type === 'space') return restriction.spaces.has(resource.id) ? 'allow' : 'deny'
    if (resource.type !== 'page') return 'allow'
    const [row] = await admin<{ space_id: string }[]>`SELECT space_id FROM pages WHERE id = ${resource.id}`
    if (!row) return 'unresolvable'
    return restriction.spaces.has(row.space_id) ? 'allow' : 'deny'
  })
}

const confined = <T>(spaces: string[], fn: () => Promise<T>) =>
  runInAuthzScope({ restriction: { spaces: new Set(spaces) } }, fn)

describe('#637: a confined principal reaches its spaces and no further', () => {
  it('check(): inside yes, outside no — and unconfined it reaches both', async () => {
    registerSpaceEvaluator()
    expect(await confined([inSpace], () => check(fgaClient, USER, 'view', { type: 'page', id: insidePage })),
      'inside the confinement, and the owner may view it').toBe(true)
    expect(await confined([inSpace], () => check(fgaClient, USER, 'view', { type: 'page', id: outsidePage })),
      'the owner may view this one — the confinement is what stops it').toBe(false)
    // the same call with no confinement proves the second answer was the restriction talking and not a
    // missing grant, which is the way this pin would otherwise pass while measuring nothing
    expect(await runInAuthzScope(SYSTEM_SCOPE, () => check(fgaClient, USER, 'view', { type: 'page', id: outsidePage })),
      'unconfined it is reachable').toBe(true)
  }, 60_000)

  it('it is an AND: inside the confinement, what the owner cannot see stays unseen', async () => {
    registerSpaceEvaluator()
    expect(await confined([inSpace], () => check(fgaClient, USER, 'view', { type: 'page', id: unseenPage })),
      'confinement does not grant anything').toBe(false)
  }, 60_000)

  it('checkRelation(): the tree and the public walk are confined too', async () => {
    registerSpaceEvaluator()
    expect(await confined([inSpace], () => checkRelation(fgaClient, USER, 'view', { type: 'page', id: insidePage }))).toBe(true)
    expect(await confined([inSpace], () => checkRelation(fgaClient, USER, 'view', { type: 'page', id: outsidePage })),
      'this is the primitive the listing surfaces use — `check` alone leaves them open').toBe(false)
  }, 60_000)

  it('filterAuthorized(): the confined ids never reach the batch', async () => {
    registerSpaceEvaluator()
    const got = await confined([inSpace], () => filterAuthorized(fgaClient, USER, 'view', [insidePage, outsidePage, unseenPage]))
    expect([...got], 'one id survives: viewable AND inside').toEqual([insidePage])
  }, 60_000)

  it('a space the key does not carry is refused directly, not only through its pages', async () => {
    registerSpaceEvaluator()
    expect(await confined([inSpace], () => checkRelation(fgaClient, USER, 'viewer', { type: 'space', id: outSpace }))).toBe(false)
  }, 60_000)
})

describe('#637: what cannot be resolved is refused, and CE owns that refusal', () => {
  it('a restriction with no evaluator registered denies everything', async () => {
    // No evaluator is what a deployment looks like with the EE overlay removed. Treating that as "no
    // restriction" is how removing a package would WIDEN every key already issued.
    expect(await confined([inSpace], () => check(fgaClient, USER, 'view', { type: 'page', id: insidePage })),
      'no rule to interpret it means the restriction stands').toBe(false)
  }, 60_000)

  it('a resource the evaluator cannot place is refused', async () => {
    registerSpaceEvaluator()
    const ghost = '00000000-0000-4000-8000-00000000dead'
    expect(await confined([inSpace], () => check(fgaClient, USER, 'view', { type: 'page', id: ghost })),
      '"I cannot tell" is not "yes"').toBe(false)
  }, 60_000)

  it('the tenant gate is out of reach of this AND, and that is measured, not assumed', () => {
    // ADR-216 §4 wanted membership and admin exempt: they are not questions about a space, and refusing
    // them would leave a confined key unable to ask who it is. No exemption was needed — both call
    // `fga.check` directly and never enter a primitive. Asserted because the exemption's absence is only
    // safe while that stays true.
    const src = readFileSync(resolve(import.meta.dirname, '..', '..', '..', '..', 'packages', 'authz', 'src', 'tenant-admin.ts'), 'utf8')
    for (const fn of ['isTenantMember', 'isTenantAdmin']) {
      const at = src.indexOf(`export async function ${fn}`)
      expect(at, `${fn} moved`).toBeGreaterThan(-1)
      const body = src.slice(at, src.indexOf('\n}', at))
      expect(body, `${fn} asks FGA directly, so the primitive AND cannot reach it`).toMatch(/fga\.check\(/)
      expect(body, `${fn} does not go through a primitive`).not.toMatch(/\bcheckRelation\(|\bcheck\(fga/)
    }
  })

  it('no restriction in scope costs one property read', async () => {
    // The ordinary request carries none, and the mechanism must not make it pay for the exception.
    expect(await runInAuthzScope(SYSTEM_SCOPE, () => check(fgaClient, USER, 'view', { type: 'page', id: insidePage }))).toBe(true)
  }, 60_000)
})

describe('#637: the rule is EE, the seam and the refusal are CE', () => {
  it('CE names no space rule of its own', () => {
    // What a `spaces` restriction MEANS is governance and lives in the EE overlay. CE holds the seam and
    // the refusal — and that split is the whole reason removing EE cannot widen a key.
    const src = readFileSync(resolve(import.meta.dirname, '..', '..', '..', '..', 'packages', 'authz', 'src', 'restriction.ts'), 'utf8')
      .split('\n').map((l) => l.replace(/^\s*[/*].*$/, '')).join('\n')
    expect(src, 'the refusal is here').toMatch(/if \(!evaluate\) return false/)
    expect(src, 'and no space rule is').not.toMatch(/space_id|spaceOfPage\s*\(/)
  })
})
