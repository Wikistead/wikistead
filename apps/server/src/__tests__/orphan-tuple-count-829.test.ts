// ADR-255 / #829: the rules that decide whether a tuple is an orphan.
//
// THE DEFECT this guards. A tuple whose object row was deleted first is invisible to every sweep the
// product has, because the sweeps work from a manifest and a manifest can only list what still has a
// row. `routes/members.ts` produces exactly that shape on purpose. What is left behind is a subject
// identifier on a group object that nothing knows about — so "your data is gone" is a claim this
// product cannot make about its authorization store.
//
// ⚠️ THE RULES ARE THE DANGEROUS PART, not the plumbing. Getting them wrong deletes live permissions,
// and the store is fail-closed: the failure is not a leak, it is everyone losing access at once. So
// they are measured here as a pure function over a scanned store and a derived live set — every case
// below has a break-check, and the two exception cases assert the ALLOWLIST as well as the behaviour,
// because a third triple added tomorrow would defend nothing while looking like it did.
import { describe, it, expect } from 'vitest'
import { groupFgaId } from '@wikistead/authz'
import { judge, GRACE_MS, RECONCILED_TYPES, type LiveSet, type ScannedTuple } from '../scripts/orphan-tuple-count.js'

const TENANT = 'tenant_a'
const OTHER = 'tenant_b'

function liveSet(over: Partial<{ pages: string[]; spaces: string[]; templates: string[]; groups: [string, string][]; tenants: string[]; members: Record<string, string[]> }> = {}): LiveSet {
  const objects = new Map<string, Set<string>>()
  for (const t of RECONCILED_TYPES) objects.set(t, new Set())
  for (const id of over.pages ?? []) objects.get('page')!.add(id)
  for (const id of over.spaces ?? []) objects.get('space')!.add(id)
  for (const id of over.templates ?? []) objects.get('template')!.add(id)
  for (const id of over.tenants ?? [TENANT]) objects.get('tenant')!.add(id)
  const groupHashToTenant = new Map<string, string>()
  for (const [tenant, name] of over.groups ?? []) {
    const hash = groupFgaId(tenant, name)
    groupHashToTenant.set(hash, tenant)
    objects.get('group')!.add(hash)
  }
  const membersByTenant = new Map<string, Set<string>>()
  for (const [tenant, subs] of Object.entries(over.members ?? { [TENANT]: [] })) membersByTenant.set(tenant, new Set(subs))
  const total = objects.get('tenant')!.size
  return { objects, groupHashToTenant, membersByTenant, derived: total, total }
}

const aged = (o: Partial<ScannedTuple> = {}): ScannedTuple => ({
  user: 'user:someone', relation: 'view_direct', object: 'page:gone',
  writtenAt: new Date(Date.now() - GRACE_MS - 60_000), ...o,
})

describe('#829 a tuple is an orphan when its OBJECT is gone', () => {
  it('finds a tuple whose page row was deleted', () => {
    const r = judge([aged()], liveSet({ pages: [] }))
    expect(r.orphans.page).toBe(1)
    expect(r.orphanTuples.map((t) => t.object)).toEqual(['page:gone'])
  })

  it('leaves a tuple alone while its page lives — whatever the relation says', () => {
    // THE DIRECTION THAT MUST NOT DRIFT. `resync.ts` names the columns where FGA is the only truth:
    // space grants, visibility markers, share links, a draft's creator grant. None has a row, so a
    // rule that consulted the relation would delete the product's own permission model.
    const live = liveSet({ pages: ['alive'] })
    for (const relation of ['view_direct', 'published', 'is_public', 'manage_direct', 'restricted']) {
      const r = judge([aged({ object: 'page:alive', relation })], live)
      expect(r.orphans.page, `${relation} was judged by its name`).toBeUndefined()
    }
  })

  it('reports a young orphan as in-grace, and the same tuple as an orphan once aged', () => {
    // The §3(b) shape: tuples written inside a transaction that then rolled back.
    const live = liveSet({ pages: [] })
    const young = judge([aged({ writtenAt: new Date(Date.now() - 60_000) })], live)
    expect(young.inGrace.page).toBe(1)
    expect(young.orphans.page).toBeUndefined()
    expect(judge([aged()], live).orphans.page).toBe(1)
  })

  it('counts a type the database cannot speak for, rather than passing it', () => {
    // "unreconciled: 0" must not be reachable by silently skipping. `user` and `share_link` have no
    // relations in today's model, so the real types cannot produce this — it is measured on a made-up
    // one, which is the only honest way to assert it.
    const r = judge([aged({ object: 'widget:1' })], liveSet())
    expect(r.unreconciledTypes.widget).toBe(1)
    expect(r.orphans.widget).toBeUndefined()
  })
})

describe('#829 the per-tuple exception is two triples, judged in one tenant', () => {
  it('finds a group membership left behind by a removed member', () => {
    // §2's example: the object lives (other members carry the group), the ONE tuple does not.
    const live = liveSet({ groups: [[TENANT, 'engineering']], members: { [TENANT]: ['still-here'] } })
    const hash = groupFgaId(TENANT, 'engineering')
    const r = judge([aged({ object: `group:${hash}`, relation: 'member', user: 'user:removed' })], live)
    expect(r.orphans.group).toBe(1)
  })

  it('spares a live membership in the tenant the hash belongs to', () => {
    const live = liveSet({ groups: [[TENANT, 'engineering']], members: { [TENANT]: ['still-here'] } })
    const hash = groupFgaId(TENANT, 'engineering')
    const r = judge([aged({ object: `group:${hash}`, relation: 'member', user: 'user:still-here' })], live)
    expect(r.orphans.group).toBeUndefined()
  })

  it('⚠️ judges a two-tenant sub in the tenant the hash names, not in "some tenant"', () => {
    // Both wrong readings fail here, in opposite directions: "no row anywhere" spares every residue,
    // "no row somewhere" deletes a live membership. The sub belongs to TENANT and was removed from
    // OTHER; the tuple under test is their LIVE one.
    const live = liveSet({
      groups: [[TENANT, 'eng'], [OTHER, 'eng']],
      tenants: [TENANT, OTHER],
      members: { [TENANT]: ['dual'], [OTHER]: [] },
    })
    const liveHash = groupFgaId(TENANT, 'eng')
    const residueHash = groupFgaId(OTHER, 'eng')
    expect(judge([aged({ object: `group:${liveHash}`, relation: 'member', user: 'user:dual' })], live).orphans.group).toBeUndefined()
    expect(judge([aged({ object: `group:${residueHash}`, relation: 'member', user: 'user:dual' })], live).orphans.group).toBe(1)
  })

  it('does not touch a group grant that names no user', () => {
    // `group:<hash>#member admin tenant:<tid>` — the shape roles.ts writes. Widening the exception
    // from the triples to the type would strip every group-granted administrator.
    const live = liveSet({ members: { [TENANT]: [] } })
    const r = judge([aged({ object: `tenant:${TENANT}`, relation: 'admin', user: `group:${groupFgaId(TENANT, 'admins')}#member` })], live)
    expect(r.orphans.tenant).toBeUndefined()
  })

  it('does not touch a tenant default', () => {
    // `tenant:<tid>#member space_creator tenant:<tid>` — seeded into every new tenant. `space_creator`
    // is not one of the two relations, so the exception never reaches it.
    const live = liveSet({ members: { [TENANT]: [] } })
    const r = judge([aged({ object: `tenant:${TENANT}`, relation: 'space_creator', user: `tenant:${TENANT}#member` })], live)
    expect(r.orphans.tenant).toBeUndefined()
  })

  it('holds the exception to exactly the two triples', () => {
    // Asserting the ALLOWLIST, not only its behaviour: the cases above defend two known shapes, and a
    // third triple added tomorrow would defend nothing while looking like it did (#719's shape).
    const live = liveSet({ members: { [TENANT]: [] } })
    for (const relation of ['space_creator', 'issue_api_keys', 'viewer', 'manage_direct']) {
      const r = judge([aged({ object: `tenant:${TENANT}`, relation, user: 'user:gone' })], live)
      expect(r.orphans.tenant, `${relation} reached the per-tuple exception`).toBeUndefined()
    }
    for (const relation of ['member', 'admin']) {
      const r = judge([aged({ object: `tenant:${TENANT}`, relation, user: 'user:gone' })], live)
      expect(r.orphans.tenant, `${relation} is one of the two and did not reach it`).toBe(1)
    }
  })
})

describe('#829 an empty derivation is a broken read, not a clean store', () => {
  it('⚠️ every tuple becomes an orphan when the live set is empty — which is why the run must abort', () => {
    // FORCE RLS answers zero rows on the runtime role with no app.tenant_id. The command refuses on
    // derived/total; this case records WHY that refusal is not optional.
    const empty = liveSet({ pages: [], tenants: [] })
    const r = judge([aged(), aged({ object: 'space:s1' })], empty)
    expect(r.orphans.page).toBe(1)
    expect(r.orphans.space).toBe(1)
    expect(r.tenantsTotal).toBe(0)
  })
})
