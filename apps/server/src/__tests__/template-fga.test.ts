// Integration test — real OpenFGA (docker compose up -d, `pnpm fga:bootstrap` with the template type).
// #247 / ADR-110: the `template` FGA type carries the audience authorization. Scope is expressed by WHICH
// tuples exist; view resolves to manage OR tenant members (audience_all) OR space viewers (space). Guests
// and public NEVER get a view. Verifies the 3-scope visibility matrix against the real evaluation engine.
import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { fgaClient, writeTuples, deleteTuples } from '@wikistead/authz'

const T = 'tenant:tpl_t'
const S = 'space:tpl_s'
const tmpl = (id: string) => `template:${id}`
const check = (user: string, relation: string, object: string) => fgaClient.check({ user, relation, object }).then((r) => r.allowed ?? false)

// identities
const OWNER = 'user:tpl_owner'
const ADMIN = 'user:tpl_admin'   // tenant admin (not a member) → sees via `admin from tenant`
const MEMBER = 'user:tpl_member' // tenant member → sees only tenant-scope templates
const SVIEWER = 'user:tpl_sviewer' // space viewer → sees only space-scope templates
const STRANGER = 'user:tpl_stranger' // no grant → sees nothing

const TUPLES = [
  { user: ADMIN, relation: 'admin', object: T },
  { user: MEMBER, relation: 'member', object: T },
  { user: SVIEWER, relation: 'viewer', object: S },
  // personal: owner + tenant only
  { user: OWNER, relation: 'owner', object: tmpl('tpl_personal') },
  { user: T, relation: 'tenant', object: tmpl('tpl_personal') },
  // space: + space
  { user: OWNER, relation: 'owner', object: tmpl('tpl_space') },
  { user: T, relation: 'tenant', object: tmpl('tpl_space') },
  { user: S, relation: 'space', object: tmpl('tpl_space') },
  // tenant: + audience_all
  { user: OWNER, relation: 'owner', object: tmpl('tpl_tenant') },
  { user: T, relation: 'tenant', object: tmpl('tpl_tenant') },
  { user: T, relation: 'audience_all', object: tmpl('tpl_tenant') },
]

describe('#247 template FGA — 3-scope visibility', () => {
  beforeAll(async () => { await writeTuples(fgaClient, TUPLES) }, 30_000)
  afterAll(async () => { await deleteTuples(fgaClient, TUPLES).catch(() => {}) }, 30_000)

  it('PERSONAL: only the owner and a tenant admin can view (not members/space-viewers/strangers)', async () => {
    const o = tmpl('tpl_personal')
    expect(await check(OWNER, 'view', o)).toBe(true)
    expect(await check(ADMIN, 'view', o)).toBe(true) // admin from tenant
    expect(await check(MEMBER, 'view', o)).toBe(false)
    expect(await check(SVIEWER, 'view', o)).toBe(false)
    expect(await check(STRANGER, 'view', o)).toBe(false)
  })

  it('SPACE: owner, admin, and the space viewers can view (not plain tenant members)', async () => {
    const o = tmpl('tpl_space')
    expect(await check(OWNER, 'view', o)).toBe(true)
    expect(await check(ADMIN, 'view', o)).toBe(true)
    expect(await check(SVIEWER, 'view', o)).toBe(true) // viewer from space
    expect(await check(MEMBER, 'view', o)).toBe(false)
    expect(await check(STRANGER, 'view', o)).toBe(false)
  })

  it('TENANT: owner, admin, and all tenant members can view (not a bare space viewer)', async () => {
    const o = tmpl('tpl_tenant')
    expect(await check(OWNER, 'view', o)).toBe(true)
    expect(await check(ADMIN, 'view', o)).toBe(true)
    expect(await check(MEMBER, 'view', o)).toBe(true) // member from audience_all
    expect(await check(SVIEWER, 'view', o)).toBe(false)
    expect(await check(STRANGER, 'view', o)).toBe(false)
  })

  it('manage (rename/delete) = owner or tenant admin only', async () => {
    const o = tmpl('tpl_tenant')
    expect(await check(OWNER, 'manage', o)).toBe(true)
    expect(await check(ADMIN, 'manage', o)).toBe(true)
    expect(await check(MEMBER, 'manage', o)).toBe(false) // a viewer is not a manager
    expect(await check(SVIEWER, 'manage', o)).toBe(false)
  })

  it('guests and public NEVER view a template (no share_link / user:* grant path)', async () => {
    // even the tenant-scope template (the widest audience) is invisible to a guest / anonymous.
    const o = tmpl('tpl_tenant')
    expect(await check('user:*', 'view', o)).toBe(false)
    expect(await check('share_link:anything', 'view', o)).toBe(false)
  })
})
