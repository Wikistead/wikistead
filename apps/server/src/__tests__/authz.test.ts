// Integration tests — runs against a real OpenFGA instance (docker compose up -d).
// No mocks: authorization is a security boundary and must be verified against
// the actual OpenFGA evaluation engine.
//
// Prerequisite: run `pnpm fga:bootstrap && pnpm fga:seed` before this suite.
import { describe, it, expect, afterAll, beforeEach, afterEach } from 'vitest'
import { fgaClient, check, checkMemberAccess, writeTuples, deleteTuples } from '@wikistead/authz'

const now = () => new Date().toISOString()
const page = (id: string) => ({ type: 'page' as const, id })

// ── Member access ─────────────────────────────────────────────────────────

describe('member access', () => {
  it('dev-user can view page:demo (via space manager inheritance)', async () => {
    expect(await check(fgaClient, 'user:dev-user', 'view', page('demo'))).toBe(true)
  })

  it('dev-user can edit page:demo', async () => {
    expect(await check(fgaClient, 'user:dev-user', 'edit', page('demo'))).toBe(true)
  })

  it('checkMemberAccess returns readOnly=false for dev-user on page:demo', async () => {
    const access = await checkMemberAccess(fgaClient, 'dev-user', page('demo'))
    expect(access).not.toBeNull()
    expect(access!.readOnly).toBe(false)
  })

  it('checkMemberAccess returns null for unknown user on page:demo', async () => {
    const access = await checkMemberAccess(fgaClient, 'unknown-user-xyz', page('demo'))
    expect(access).toBeNull()
  })
})

// ── Cross-tenant isolation ────────────────────────────────────────────────
//
// OpenFGA enforces isolation via the tuple graph, not via a hard model
// constraint. Cross-tenant access is impossible when no cross-tenant tuples
// exist; it WOULD succeed if such tuples were accidentally written.
//
// The anti-test below proves the false results are non-trivial: the same
// infrastructure that makes the isolation tests pass also makes cross-tenant
// access possible when a tuple is explicitly written — confirming that the
// isolation boundary is real and not an artifact of an empty graph.

describe('cross-tenant isolation', () => {
  it('dev-user cannot view page:acme_page (different tenant)', async () => {
    // dev-user has manager access to space:demo_space (tenant_dev) but no
    // relation to space:acme_space or page:acme_page (tenant_acme).
    expect(await check(fgaClient, 'user:dev-user', 'view', page('acme_page'))).toBe(false)
  })

  it('acme-admin cannot view page:demo (different tenant)', async () => {
    expect(await check(fgaClient, 'user:acme-admin', 'view', page('demo'))).toBe(false)
  })

  it('cross-tenant access IS granted when a cross-tenant tuple exists (anti-test)', async () => {
    // Proves the isolation tests are non-trivial: the model does not prevent
    // cross-tenant tuples — the application layer must never write them.
    await writeTuples(fgaClient, [
      { user: 'user:dev-user', relation: 'viewer', object: 'space:acme_space' },
    ])
    expect(await check(fgaClient, 'user:dev-user', 'view', page('acme_page'))).toBe(true)

    // Cleanup — restore isolation.
    await deleteTuples(fgaClient, [
      { user: 'user:dev-user', relation: 'viewer', object: 'space:acme_space' },
    ])
    expect(await check(fgaClient, 'user:dev-user', 'view', page('acme_page'))).toBe(false)
  })
})

// ── Monotonic deny — restricted (#109 / ADR-072) ──────────────────────────
//
// A principal listed in page#restricted cannot view the page even if they'd
// otherwise qualify (space viewer, direct grant, public, commenter). Deny wins
// over every grant path: view = viewable but not restricted. These run against
// the real OpenFGA engine (security boundary). A dedicated page id keeps the
// heavily-shared page:demo state clean; one test uses dev-user's space-viewer
// path on page:demo but restores it.

describe('monotonic deny — restricted', () => {
  const PG = 'restrict-test-pg'
  const restr = (u: string) => ({ user: `user:${u}`, relation: 'restricted', object: `page:${PG}` })
  const grant = (u: string) => ({ user: `user:${u}`, relation: 'view_direct', object: `page:${PG}` })
  const pub = { user: 'user:*', relation: 'view_base', object: `page:${PG}` }
  const ALL = [
    restr('alice'), restr('bob'), restr('carol'), grant('alice'), grant('bob'), grant('carol'), pub,
    { user: 'user:dev-user', relation: 'restricted', object: 'page:demo' },
  ]
  // writeTuples is ATOMIC and rejects a duplicate, so a prior failed run's leftovers would break the
  // next write. Delete each tuple individually (ignore "not found") BOTH before and after — no test
  // pollutes page:demo or the shared graph even if it throws mid-way.
  const clean = async () => { for (const t of ALL) await deleteTuples(fgaClient, [t]).catch(() => {}) }
  beforeEach(clean)
  afterEach(clean)

  it('deny wins over a direct view_base grant (grant → view; +restricted → deny)', async () => {
    await writeTuples(fgaClient, [grant('alice')])
    expect(await check(fgaClient, 'user:alice', 'view', page(PG))).toBe(true)
    await writeTuples(fgaClient, [restr('alice')])
    expect(await check(fgaClient, 'user:alice', 'view', page(PG))).toBe(false)
  })

  it('restriction is per-principal — restricting alice does not affect bob', async () => {
    await writeTuples(fgaClient, [grant('alice'), grant('bob'), restr('alice')])
    expect(await check(fgaClient, 'user:alice', 'view', page(PG))).toBe(false)
    expect(await check(fgaClient, 'user:bob', 'view', page(PG))).toBe(true)
  })

  it('deny hides a PUBLIC page from a restricted member (view=false despite user:*)', async () => {
    await writeTuples(fgaClient, [pub, restr('carol')])
    expect(await check(fgaClient, 'user:anyone-else', 'view', page(PG))).toBe(true) // public → anyone views
    expect(await check(fgaClient, 'user:carol', 'view', page(PG))).toBe(false) // ...except the restricted member
  })

  it('deny wins over the space-viewer path (space viewer but page restricted → denied)', async () => {
    // dev-user views page:demo via space manager inheritance (baseline true).
    expect(await check(fgaClient, 'user:dev-user', 'view', page('demo'))).toBe(true)
    await writeTuples(fgaClient, [{ user: 'user:dev-user', relation: 'restricted', object: 'page:demo' }])
    expect(await check(fgaClient, 'user:dev-user', 'view', page('demo'))).toBe(false)
    // NOTE: ADR-072 scopes the deny to `view`; `edit` has its own grant path and is NOT subtracted here.
    // Whether restriction should also block edit is a follow-up decision (see the ticket) — not asserted.
  })
})

// ── Private (allowlist) — ADR-098 (#109) ──────────────────────────────────
//
// Populating `private@user:*` cuts the space-inherited grant paths (manager/editor/viewer from space)
// for view AND edit AND manage — so ONLY the explicit direct grants (the allow list) remain. An empty
// marker is a 1:1 no-op. Deny (`restricted`) still wins over the allow list. These run against the real
// OpenFGA engine (security boundary). A dedicated page keeps the shared graph clean.

describe('private allowlist — ADR-098', () => {
  const PG = 'private-test-pg'
  const obj = `page:${PG}`
  const priv = { user: 'user:*', relation: 'private', object: obj }
  const spaceLink = { user: 'space:demo_space', relation: 'space', object: obj } // inherit demo_space grants
  const allow = (u: string, rel = 'view_direct') => ({ user: `user:${u}`, relation: rel, object: obj })
  const groupAllow = { user: 'group:execs#member', relation: 'view_direct', object: obj }
  const restr = (u: string) => ({ user: `user:${u}`, relation: 'restricted', object: obj })
  const ALL = [
    priv, spaceLink, allow('dev-user'), allow('dev-user', 'edit'), allow('dev-user', 'manage'),
    allow('alice'), groupAllow, restr('alice'),
    { user: 'user:erin', relation: 'member', object: 'group:execs' },
  ]
  const clean = async () => { for (const t of ALL) await deleteTuples(fgaClient, [t]).catch(() => {}) }
  beforeEach(clean)
  afterEach(clean)

  it('empty private marker is a no-op — space inheritance still grants view (backward compatible)', async () => {
    await writeTuples(fgaClient, [spaceLink])
    // dev-user is manager of demo_space → inherits view on a page linked to demo_space, no private set.
    expect(await check(fgaClient, 'user:dev-user', 'view', page(PG))).toBe(true)
  })

  it('private cuts space inheritance for view AND edit AND manage (no back door — the "hole 2" fix)', async () => {
    await writeTuples(fgaClient, [spaceLink])
    expect(await check(fgaClient, 'user:dev-user', 'view', page(PG))).toBe(true) // baseline via space
    await writeTuples(fgaClient, [priv])
    // all three inherited paths are cut — dev-user (space manager) loses view/edit/manage.
    expect(await check(fgaClient, 'user:dev-user', 'view', page(PG))).toBe(false)
    expect(await check(fgaClient, 'user:dev-user', 'edit', page(PG))).toBe(false)
    expect(await check(fgaClient, 'user:dev-user', 'manage', page(PG))).toBe(false)
  })

  it('an explicit direct grant (the allow list) survives private — only allowed principals get in', async () => {
    await writeTuples(fgaClient, [spaceLink, priv])
    expect(await check(fgaClient, 'user:alice', 'view', page(PG))).toBe(false) // not on the allow list
    await writeTuples(fgaClient, [allow('alice')]) // add alice to the allow list
    expect(await check(fgaClient, 'user:alice', 'view', page(PG))).toBe(true)
    // a non-allowed principal (bob) still cannot view — existence is not leaked at the authz layer.
    expect(await check(fgaClient, 'user:bob', 'view', page(PG))).toBe(false)
  })

  it('a group#member allow works on a private page (exec-group use case)', async () => {
    await writeTuples(fgaClient, [spaceLink, priv, groupAllow, { user: 'user:erin', relation: 'member', object: 'group:execs' }])
    expect(await check(fgaClient, 'user:erin', 'view', page(PG))).toBe(true) // via group:execs#member on the allow list
    expect(await check(fgaClient, 'user:frank', 'view', page(PG))).toBe(false) // not in the group
  })

  it('deny (restricted) wins over the private allow list (private ∘ restrict)', async () => {
    await writeTuples(fgaClient, [priv, allow('alice')])
    expect(await check(fgaClient, 'user:alice', 'view', page(PG))).toBe(true) // allowed
    await writeTuples(fgaClient, [restr('alice')])
    expect(await check(fgaClient, 'user:alice', 'view', page(PG))).toBe(false) // deny still wins
  })
})

// ── share_link: non-expiring (no condition) ───────────────────────────────

describe('non-expiring share_link', () => {
  it('demo_view_perm can view page:demo', async () => {
    expect(
      await check(fgaClient, 'share_link:demo_view_perm', 'view', page('demo'), { current_time: now() }),
    ).toBe(true)
  })

  it('demo_view_perm cannot edit page:demo (view-only link)', async () => {
    expect(
      await check(fgaClient, 'share_link:demo_view_perm', 'edit', page('demo'), { current_time: now() }),
    ).toBe(false)
  })
})

// ── share_link: time-bounded (with non_expired condition) ─────────────────
// Tests create their own fresh tuples to avoid depending on the 1-hour seed expiry.

describe('time-bounded share_link', () => {
  const LINK = 'share_link:authz_test_temp_edit'
  const expiresAt = () => new Date(Date.now() + 3600_000).toISOString()

  beforeEach(async () => {
    await writeTuples(fgaClient, [
      { user: LINK, relation: 'edit_direct', object: 'page:demo',
        condition: { name: 'non_expired', context: { expires_at: expiresAt() } } },
    ])
  })
  afterEach(async () => {
    await deleteTuples(fgaClient, [{ user: LINK, relation: 'edit_direct', object: 'page:demo' }])
  })

  it('time-bounded link can edit page:demo before expiry', async () => {
    expect(
      await check(fgaClient, LINK, 'edit', page('demo'), { current_time: now() }),
    ).toBe(true)
  })

  it('time-bounded link cannot edit page:demo after expiry', async () => {
    // current_time far in the future → condition fails
    const pastExpiry = new Date(Date.now() + 7200_000).toISOString()
    expect(
      await check(fgaClient, LINK, 'edit', page('demo'), { current_time: pastExpiry }),
    ).toBe(false)
  })

  it('writeTuples accepts condition with expires_at context', async () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString()
    await writeTuples(fgaClient, [
      {
        user: 'share_link:condition_write_test',
        relation: 'view_direct', // #100: direct view grant → view_base leaf (view is computed)
        object: 'page:demo',
        condition: { name: 'non_expired', context: { expires_at: expiresAt } },
      },
    ])
    expect(
      await check(fgaClient, 'share_link:condition_write_test', 'view', page('demo'), { current_time: now() }),
    ).toBe(true)
    // cleanup
    await deleteTuples(fgaClient, [{ user: 'share_link:condition_write_test', relation: 'view_direct', object: 'page:demo' }])
  })
})

// ── Revocation (tuple deletion → next onAuthenticate check fails) ─────────

describe('share_link revocation', () => {
  it('deleting a share_link tuple is immediately reflected in subsequent checks', async () => {
    // Write a permanent view link for a test page.
    await writeTuples(fgaClient, [
      { user: 'share_link:revoke_test', relation: 'view_direct', object: 'page:demo' },
    ])
    expect(
      await check(fgaClient, 'share_link:revoke_test', 'view', page('demo'), { current_time: now() }),
    ).toBe(true)

    // Revoke by deleting the tuple.
    await deleteTuples(fgaClient, [
      { user: 'share_link:revoke_test', relation: 'view_direct', object: 'page:demo' },
    ])

    // The next FGA check — which is what onAuthenticate runs on every new
    // WebSocket connection — now returns false. Connected guests holding a
    // still-valid JWT continue until exp; revocation is enforced at the next
    // onAuthenticate call (reconnect or token refresh).
    expect(
      await check(fgaClient, 'share_link:revoke_test', 'view', page('demo'), { current_time: now() }),
    ).toBe(false)
  })
})
