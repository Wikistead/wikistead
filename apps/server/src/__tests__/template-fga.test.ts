// Integration test — real OpenFGA (docker compose up -d, `pnpm fga:bootstrap` with the current model).
// #247 / ADR-110 + #258: the `template` FGA type carries the audience authorization. Scope is expressed by
// WHICH tuples exist; view = manage OR tenant members (audience_all) OR space MEMBERS (viewer_member from
// space). Guests (share_link) and public (user:*) NEVER get a view — #258 fixed a leak where template#view
// inherited `viewer from space` (which includes the public wildcard + share_link on a public/shared space),
// so a space-scoped template of a public/shared space was visible to anon/guests. It now inherits
// `viewer_member` (the member-only subset). Verified against the real evaluation engine.
import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { fgaClient, writeTuples, deleteTuples } from '@wikistead/authz'
import { backfillSpaceViewerMembers } from '../routes/spaces.js'

const T = 'tenant:tpl_t'
const S = 'space:tpl_s'          // a normal (member-only) space
const PS = 'space:tpl_ps'        // a PUBLIC / share-linked space
const PS_ID = 'tpl_ps'
const tmpl = (id: string) => `template:${id}`
const check = (user: string, relation: string, object: string) => fgaClient.check({ user, relation, object }).then((r) => r.allowed ?? false)

// identities
const OWNER = 'user:tpl_owner'
const ADMIN = 'user:tpl_admin'   // tenant admin (not a member) → sees via `admin from tenant`
const MEMBER = 'user:tpl_member' // tenant member → sees only tenant-scope templates
const SVIEWER = 'user:tpl_sviewer' // space MEMBER (granted via the write path = viewer + viewer_member)
const PSMEMBER = 'user:tpl_psmember' // a member of the PUBLIC space (viewer_member) → sees its space templates
const STRANGER = 'user:tpl_stranger' // no grant → sees nothing
const SHARE = 'share_link:tpl_link'

const TUPLES = [
  { user: ADMIN, relation: 'admin', object: T },
  { user: MEMBER, relation: 'member', object: T },
  // #258: a member VIEW grant writes BOTH viewer and viewer_member (spaceGrantTuples) — mirror that here.
  { user: SVIEWER, relation: 'viewer', object: S },
  { user: SVIEWER, relation: 'viewer_member', object: S },
  // the PUBLIC space: public wildcard + a share link on `viewer` (its pages are anon/guest viewable) …
  { user: 'user:*', relation: 'viewer', object: PS },
  { user: SHARE, relation: 'viewer', object: PS },
  // … plus a real member of it (viewer + viewer_member).
  { user: PSMEMBER, relation: 'viewer', object: PS },
  { user: PSMEMBER, relation: 'viewer_member', object: PS },
  // personal: owner + tenant only
  { user: OWNER, relation: 'owner', object: tmpl('tpl_personal') },
  { user: T, relation: 'tenant', object: tmpl('tpl_personal') },
  // space: + space (member-only space)
  { user: OWNER, relation: 'owner', object: tmpl('tpl_space') },
  { user: T, relation: 'tenant', object: tmpl('tpl_space') },
  { user: S, relation: 'space', object: tmpl('tpl_space') },
  // space-scope template of the PUBLIC space (the #258 leak scenario)
  { user: OWNER, relation: 'owner', object: tmpl('tpl_pub_space') },
  { user: T, relation: 'tenant', object: tmpl('tpl_pub_space') },
  { user: PS, relation: 'space', object: tmpl('tpl_pub_space') },
  // tenant: + audience_all
  { user: OWNER, relation: 'owner', object: tmpl('tpl_tenant') },
  { user: T, relation: 'tenant', object: tmpl('tpl_tenant') },
  { user: T, relation: 'audience_all', object: tmpl('tpl_tenant') },
]

describe('#247/#258 template FGA — 3-scope visibility + guest/public hard boundary', () => {
  beforeAll(async () => { await writeTuples(fgaClient, TUPLES) }, 30_000)
  afterAll(async () => { await deleteTuples(fgaClient, TUPLES).catch(() => {}) }, 30_000)

  it('PERSONAL: only the owner and a tenant admin can view', async () => {
    const o = tmpl('tpl_personal')
    expect(await check(OWNER, 'view', o)).toBe(true)
    expect(await check(ADMIN, 'view', o)).toBe(true) // admin from tenant
    expect(await check(MEMBER, 'view', o)).toBe(false)
    expect(await check(SVIEWER, 'view', o)).toBe(false)
    expect(await check(STRANGER, 'view', o)).toBe(false)
  })

  it('SPACE: owner, admin, and the space MEMBERS can view (not plain tenant members)', async () => {
    const o = tmpl('tpl_space')
    expect(await check(OWNER, 'view', o)).toBe(true)
    expect(await check(ADMIN, 'view', o)).toBe(true)
    expect(await check(SVIEWER, 'view', o)).toBe(true) // viewer_member from space
    expect(await check(MEMBER, 'view', o)).toBe(false)
    expect(await check(STRANGER, 'view', o)).toBe(false)
  })

  it('TENANT: owner, admin, and all tenant members can view (not a bare space member)', async () => {
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
    expect(await check(MEMBER, 'manage', o)).toBe(false)
    expect(await check(SVIEWER, 'manage', o)).toBe(false)
  })

  it('#258: a PUBLIC / share-linked space does NOT leak its space-scope template to public / guests', async () => {
    const o = tmpl('tpl_pub_space') // space-scope template of a space that is public (viewer@user:*) + shared
    // the leak: before #258, template#view inherited `viewer from space`, so these were TRUE.
    expect(await check('user:*', 'view', o)).toBe(false)       // public wildcard
    expect(await check(SHARE, 'view', o)).toBe(false)          // share-link guest
    // …but a real MEMBER of that space (viewer_member) still sees it.
    expect(await check(PSMEMBER, 'view', o)).toBe(true)
  })

  it('guests and public NEVER view a template (no share_link / user:* grant path — the documented boundary)', async () => {
    const o = tmpl('tpl_tenant') // the widest audience is still invisible to guests/anon
    expect(await check('user:*', 'view', o)).toBe(false)
    expect(await check('share_link:anything', 'view', o)).toBe(false)
  })

  it('#258: page view inheritance via space#viewer is UNCHANGED (a space member still views the space pages)', async () => {
    // viewer keeps its direct types + unions viewer_member, so a member with viewer_member also has `viewer`.
    expect(await check(SVIEWER, 'viewer', S)).toBe(true)
    expect(await check('user:*', 'viewer', PS)).toBe(true) // a public space is still anon-viewable at the space level
  })

  it('#258 backfill: a pre-migration viewer-only member gains template visibility after backfill', async () => {
    const BS = 'space:tpl_backfill'
    const BFMEMBER = 'user:tpl_bf_member'
    const bfTmpl = tmpl('tpl_bf')
    const setup = [
      // a member granted BEFORE #258 (viewer only, no viewer_member) + a space-scope template
      { user: BFMEMBER, relation: 'viewer', object: BS },
      { user: 'user:*', relation: 'viewer', object: BS }, // a wildcard that must NOT be backfilled
      { user: OWNER, relation: 'owner', object: bfTmpl },
      { user: T, relation: 'tenant', object: bfTmpl },
      { user: 'space:tpl_backfill', relation: 'space', object: bfTmpl },
    ]
    await writeTuples(fgaClient, setup)
    try {
      // BEFORE backfill: viewer-only member can't see the space template (viewer_member missing).
      expect(await check(BFMEMBER, 'view', bfTmpl)).toBe(false)
      const written = await backfillSpaceViewerMembers(fgaClient, ['tpl_backfill'])
      expect(written).toBe(1) // the member — NOT the wildcard
      // AFTER: the member now sees it; the public wildcard still does not (never backfilled).
      expect(await check(BFMEMBER, 'view', bfTmpl)).toBe(true)
      expect(await check('user:*', 'view', bfTmpl)).toBe(false)
      // idempotent: a second run writes nothing.
      expect(await backfillSpaceViewerMembers(fgaClient, ['tpl_backfill'])).toBe(0)
    } finally {
      await deleteTuples(fgaClient, [...setup, { user: BFMEMBER, relation: 'viewer_member', object: BS }]).catch(() => {})
    }
  })
})
