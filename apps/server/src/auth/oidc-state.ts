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
  // #554 S2 / ADR-197 §2 (the B3 generalization): the CONNECTION this state was minted under.
  // The callback re-resolves and completes ONLY against this exact connection — a state minted
  // for connection A never completes against connection B, and disabling a connection closes its
  // 300s window. Absent on legacy (connection-less) starts, which keep the kind-level check.
  connectionId?: string
  // Present when the login was started from an invite link. Carried through the
  // OIDC round-trip so /auth/callback can accept the invite (the new membership
  // grant) once identity is proven. The invite row is itself consume-once, and so
  // is this state (GETDEL) — double single-use.
  inviteToken?: string
  // #947 / ADR-259 §3.3: present only for a connection-LINKING round trip, started from account
  // settings by a member who is already signed in. Carries THAT member's sub — never a proof of
  // somebody else's identity — so /auth/link-callback can refuse unless the request arrives in the
  // SAME session as this same member (the linking-CSRF defence; a stolen link-start URL handed to a
  // victim resolves against the victim's own session, which will never match).
  linkMemberSub?: string
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
