// The search viewer denormalisation must read EVERY tuple on an object, not the first page of them.
//
// `fga.read` answers one page (50 by default) plus a continuation token. buildSearchDoc ignored the
// token, so once an object carried more than a page of tuples, whichever viewers sorted past the cut
// silently vanished from `viewerUsers` — the document still indexed, just without them. Stage 2 cannot
// repair that: it only NARROWS the stage-1 candidate set, so a hit stage 1 never produced is
// unrecoverable. The result is a member who can open a page but cannot find it, with no error anywhere.
//
// It was found the ordinary way: the server-test stack crossed 57 tuples on tenant:tenant_dev, the
// admin tuple there sorted past the cut, and two unrelated search suites went red.
//
// The pin aims at the SPACE read on purpose. The tenant read now asks FGA for the `admin` relation
// only, so it returns a handful of tuples and cannot page — narrowing it made the tenant version of
// this test VACUOUS (it passed with pagination removed), which is the trap this file exists to avoid.
// The space read is the one that still pulls every relation on the object, and a space with more than
// fifty grants is entirely ordinary.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import * as Y from 'yjs'
import { pool } from '../db/pool.js'
import { fgaClient, writeTuples, deleteTuples } from '@wikistead/authz'
import { buildSearchDoc } from '../search/doc-builder.js'

const admin = postgres(process.env.DATABASE_ADMIN_URL!)
const STAMP = Date.now().toString(36)
const TENANT = `tenant_dnp_${STAMP}`
const SPACE = `dnp-space-${STAMP}`
const PAGE = `dnp-page-${STAMP}`
// One page of tuples is 50; go past it so the subject cannot be in the first page.
const PADDING = Array.from({ length: 60 }, (_, i) => `dnp-pad-${i}-${STAMP}`)          // space viewers
const TENANT_ONLY = Array.from({ length: 60 }, (_, i) => `dnp-tonly-${i}-${STAMP}`)     // tenant members, NOT space viewers
const LATE_VIEWER = `zzz-late-viewer-${STAMP}` // sorts late on purpose
const LATE_ADMIN = `zzz-late-admin-${STAMP}`

const spaceTuples = [
  ...PADDING.map((sub) => ({ user: `user:${sub}`, relation: 'viewer', object: `space:${SPACE}` })),
  { user: `user:${LATE_VIEWER}`, relation: 'viewer', object: `space:${SPACE}` },
]
const tenantTuples = [
  ...TENANT_ONLY.map((sub) => ({ user: `user:${sub}`, relation: 'member', object: `tenant:${TENANT}` })),
  { user: `user:${LATE_ADMIN}`, relation: 'admin', object: `tenant:${TENANT}` },
]
const structureTuples = [
  { user: `tenant:${TENANT}`, relation: 'tenant', object: `space:${SPACE}` },
  { user: `space:${SPACE}`, relation: 'space', object: `page:${PAGE}` },
]

beforeAll(async () => {
  await admin`INSERT INTO tenants (id, slug, plan) VALUES (${TENANT}, ${TENANT}, 'free')`
  await admin`INSERT INTO spaces (id, tenant_id, name) VALUES (${SPACE}, ${TENANT}, 'Denorm')`
  const body = '# Denorm\n\nsearchable body\n'
  const d = new Y.Doc(); d.getText('content').insert(0, body)
  await admin`
    INSERT INTO pages (id, tenant_id, space_id, title, ydoc, published_md)
    VALUES (${PAGE}, ${TENANT}, ${SPACE}, 'Denorm', ${Buffer.from(Y.encodeStateAsUpdate(d))}, ${body})`
  // one at a time: OpenFGA rejects the whole batch if any tuple already exists
  for (const t of [...structureTuples, ...spaceTuples, ...tenantTuples]) await writeTuples(fgaClient, [t]).catch(() => {})
}, 180_000)

afterAll(async () => {
  for (const t of [...spaceTuples, ...tenantTuples, ...structureTuples]) await deleteTuples(fgaClient, [t]).catch(() => {})
  // Delete the rows that REFER to the tenant before the tenant itself: an outbox row whose tenant no
  // longer exists can never be drained and quietly poisons the shared stack's drain batches.
  await admin`DELETE FROM search_outbox WHERE tenant_id = ${TENANT}`.catch(() => {})
  await admin`DELETE FROM audit_outbox WHERE tenant_id = ${TENANT}`.catch(() => {})
  await admin`DELETE FROM audit_log WHERE tenant_id = ${TENANT}`.catch(() => {})
  await admin`DELETE FROM pages WHERE tenant_id = ${TENANT}`.catch(() => {})
  await admin`DELETE FROM spaces WHERE tenant_id = ${TENANT}`.catch(() => {})
  await admin`DELETE FROM members WHERE tenant_id = ${TENANT}`.catch(() => {})
  await admin`DELETE FROM tenants WHERE id = ${TENANT}`.catch(() => {})
  await admin.end(); await pool.end()
}, 180_000)

describe('search viewer denormalisation reads past the first page of tuples', () => {
  it('a space viewer beyond the 50-tuple window is STILL a stage-1 viewer', async () => {
    // Prove the fixture actually reproduces the condition rather than asserting into thin air: the
    // subject must genuinely be absent from an unpaginated read, or this test passes for free.
    const firstPage = await fgaClient.read({ object: `space:${SPACE}` })
    expect(firstPage.continuation_token, 'the object spans more than one page').toBeTruthy()
    expect(
      (firstPage.tuples ?? []).some((t) => t.key?.user === `user:${LATE_VIEWER}`),
      'the viewer is NOT in the first page — that is the whole point',
    ).toBe(false)

    const doc = await buildSearchDoc(admin, fgaClient, PAGE, TENANT)
    expect(doc).not.toBeNull()
    expect(doc!.viewerUsers, 'the viewer is denormalised despite sorting past the cut').toContain(`user:${LATE_VIEWER}`)
  }, 60_000)

  it('a tenant admin is denormalised even when the membership dwarfs the admin list', async () => {
    // NOT the pagination pin (the tenant read asks for `admin` only, so it does not page here) — this
    // guards the narrowing itself: ask FGA for the wrong relation, or drop the filter's result handling,
    // and the tenant admins stop reaching the viewer set at all.
    const doc = await buildSearchDoc(admin, fgaClient, PAGE, TENANT)
    expect(doc!.viewerUsers).toContain(`user:${LATE_ADMIN}`)
    // A plain tenant MEMBER (no space grant) is not a viewer — only the admin relation reaches through
    // the tenant object, so a filter that accidentally admitted `member` would show up right here.
    expect(doc!.viewerUsers).not.toContain(`user:${TENANT_ONLY[0]}`)
  }, 60_000)
})
