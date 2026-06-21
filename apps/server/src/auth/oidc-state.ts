// OIDC login state, stored in Valkey between /auth/login and /auth/callback.
// Short-lived AND consume-once: CSRF state must not be replayable. consumeState
// uses GETDEL so read+delete is atomic (no get-then-del race where two callbacks
// both see the same state).
import type IORedis from 'ioredis'

const STATE_TTL_S = 300 // login→callback window only
const key = (state: string) => `oidcstate:${state}`

export interface OidcLoginState {
  nonce: string
  codeVerifier: string
  tenantId: string
  returnTo: string
  // Which config authenticated: the tenant's own IdP (eligible for CE first-admin
  // bootstrap) vs the platform IdP (Cloud — never bootstraps; admin comes from signup).
  viaTenantOidc: boolean
  // Present when the login was started from an invite link. Carried through the
  // OIDC round-trip so /auth/callback can accept the invite (the new membership
  // grant) once identity is proven. The invite row is itself consume-once, and so
  // is this state (GETDEL) — double single-use.
  inviteToken?: string
}

export async function saveState(valkey: IORedis, state: string, data: OidcLoginState): Promise<void> {
  await valkey.set(key(state), JSON.stringify(data), 'EX', STATE_TTL_S)
}

// Atomically fetch-and-delete. Returns null if the state is unknown, expired, or
// already consumed — so an invalid OR reused state both fail.
export async function consumeState(valkey: IORedis, state: string): Promise<OidcLoginState | null> {
  if (!state) return null
  const raw = await valkey.getdel(key(state))
  if (!raw) return null
  try {
    return JSON.parse(raw) as OidcLoginState
  } catch {
    return null
  }
}
