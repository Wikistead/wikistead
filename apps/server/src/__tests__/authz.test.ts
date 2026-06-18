// Integration tests — runs against a real OpenFGA instance (docker compose up -d).
// No mocks: authorization is a security boundary and must be verified against
// the actual OpenFGA evaluation engine.
//
// Prerequisite: run `pnpm fga:bootstrap && pnpm fga:seed` before this suite.
import { describe, it, expect, afterAll } from 'vitest'
import { fgaClient, check, checkMemberAccess, writeTuples, deleteTuples } from '@kb/authz'

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

describe('cross-tenant isolation', () => {
  it('dev-user cannot view page:acme_page (different tenant)', async () => {
    expect(await check(fgaClient, 'user:dev-user', 'view', page('acme_page'))).toBe(false)
  })

  it('acme-admin cannot view page:demo (different tenant)', async () => {
    expect(await check(fgaClient, 'user:acme-admin', 'view', page('demo'))).toBe(false)
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

describe('time-bounded share_link', () => {
  it('demo_edit_temp can edit page:demo before expiry', async () => {
    expect(
      await check(fgaClient, 'share_link:demo_edit_temp', 'edit', page('demo'), { current_time: now() }),
    ).toBe(true)
  })

  it('demo_edit_temp cannot edit page:demo after expiry', async () => {
    // current_time far in the future → condition fails
    const pastExpiry = new Date(Date.now() + 7200_000).toISOString()
    expect(
      await check(fgaClient, 'share_link:demo_edit_temp', 'edit', page('demo'), { current_time: pastExpiry }),
    ).toBe(false)
  })

  it('writeTuples accepts condition with expires_at context', async () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString()
    await writeTuples(fgaClient, [
      {
        user: 'share_link:condition_write_test',
        relation: 'view',
        object: 'page:demo',
        condition: { name: 'non_expired', context: { expires_at: expiresAt } },
      },
    ])
    expect(
      await check(fgaClient, 'share_link:condition_write_test', 'view', page('demo'), { current_time: now() }),
    ).toBe(true)
    // cleanup
    await deleteTuples(fgaClient, [{ user: 'share_link:condition_write_test', relation: 'view', object: 'page:demo' }])
  })
})

// ── Revocation (tuple deletion → next onAuthenticate check fails) ─────────

describe('share_link revocation', () => {
  it('deleting a share_link tuple is immediately reflected in subsequent checks', async () => {
    // Write a permanent view link for a test page.
    await writeTuples(fgaClient, [
      { user: 'share_link:revoke_test', relation: 'view', object: 'page:demo' },
    ])
    expect(
      await check(fgaClient, 'share_link:revoke_test', 'view', page('demo'), { current_time: now() }),
    ).toBe(true)

    // Revoke by deleting the tuple.
    await deleteTuples(fgaClient, [
      { user: 'share_link:revoke_test', relation: 'view', object: 'page:demo' },
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
