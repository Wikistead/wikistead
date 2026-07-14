// #111 / ADR-046: members.groups → FGA group#member sync. Real OpenFGA (no mocks). Security-
// critical: this is how a group grant resolves to its members (and, via page view, who is
// @mentionable). Verifies the diff (add/remove), that a group grant resolves view for a synced
// member, that dropping the group revokes it, and that the group id is tenant-unique + FGA-safe.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { fgaClient, checkRelation, writeTuples, deleteTuples } from '@wikistead/authz'
import { groupFgaId, syncMemberGroups } from '../auth/group-sync.js'

const T = 'tenant_dev'
const SUB = 'gsync-user'
const PAGE = 'gsync-page'
const gid = (n: string) => groupFgaId(T, n)
// group is not a page/space ResourceRef, so check membership via the raw FGA client.
const isMember = async (n: string) =>
  (await fgaClient.check({ user: `user:${SUB}`, relation: 'member', object: `group:${gid(n)}` })).allowed === true
const grantTuple = { user: `group:${gid('Engineering')}#member`, relation: 'view_direct', object: `page:${PAGE}` }

// Deterministic reset (delete each candidate tuple individually so a missing one can't abort a
// batch — writeTuples/deleteTuples are not idempotent). Run before AND after so a prior run's
// leftover can't make the fresh writes duplicate.
const reset = async () => {
  const tuples = [
    { user: `user:${SUB}`, relation: 'member', object: `group:${gid('Engineering')}` },
    { user: `user:${SUB}`, relation: 'member', object: `group:${gid('Sales')}` },
    grantTuple,
  ]
  for (const t of tuples) await deleteTuples(fgaClient, [t]).catch(() => {})
}
beforeAll(reset)
afterAll(reset)

describe('#111 group-sync', () => {
  it('groupFgaId is deterministic, tenant-unique, and FGA-id-safe (hex)', () => {
    expect(groupFgaId(T, 'Engineering')).toBe(groupFgaId(T, 'Engineering')) // same (tenant,name) → same id
    expect(groupFgaId(T, 'Engineering')).not.toBe(groupFgaId('tenant_acme', 'Engineering')) // tenant-unique
    expect(groupFgaId(T, '営業 / Sales チーム')).toMatch(/^[0-9a-f]+$/) // JP/space/symbol name → safe id
  })

  it('diffs add/remove, a group grant resolves view, and dropping the group revokes it', async () => {
    // A page granted to the Engineering group.
    await writeTuples(fgaClient, [grantTuple])

    // Login 1: the member joins Engineering + Sales → both group#member tuples written.
    await syncMemberGroups(fgaClient, T, SUB, [], ['Engineering', 'Sales'])
    expect(await isMember('Engineering')).toBe(true)
    expect(await isMember('Sales')).toBe(true)
    // The group grant resolves to a page view for the member (this is what makes a group grant
    // work and the member @mentionable on the page).
    expect(await checkRelation(fgaClient, `user:${SUB}`, 'view', { type: 'page', id: PAGE })).toBe(true)

    // Login 2: claims drop Engineering (keep Sales) → only that tuple is deleted (diff), and the
    // page view it conferred is revoked; Sales remains.
    await syncMemberGroups(fgaClient, T, SUB, ['Engineering', 'Sales'], ['Sales'])
    expect(await isMember('Engineering')).toBe(false)
    expect(await isMember('Sales')).toBe(true)
    expect(await checkRelation(fgaClient, `user:${SUB}`, 'view', { type: 'page', id: PAGE })).toBe(false)
  })
})
