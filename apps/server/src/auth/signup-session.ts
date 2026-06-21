// Signup session (P1.2 P2d): a SHORT-LIVED "one-time pass for tenant creation",
// deliberately kept SEPARATE from the member authz session (auth/session.ts):
//   - different cookie name (wks_signup, not wks_sess),
//   - different Valkey prefix (signup:<sid>),
//   - cookie Path=/signup so the browser NEVER sends it to /api or /collab.
// The main onRequest hook reads ONLY wks_sess, so a signup session can do nothing
// except create a tenant on /signup/*. It holds an IDENTITY verified by the
// platform IdP but NO tenant membership. On successful tenant creation it is
// consumed and replaced by a real member session (same "don't mix session kinds"
// discipline as the host-only member cookie).
import { randomBytes } from 'node:crypto'
import type IORedis from 'ioredis'

export const SIGNUP_COOKIE = 'wks_signup'
const TTL_S = 900 // 15 min to pick a workspace name
const key = (sid: string) => `signup:${sid}`

export interface SignupSession {
  sub: string
  email: string | null
  name: string | null
}

// Path=/signup confines the cookie to the signup flow at the browser level too.
export function signupCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/signup',
  }
}

export async function createSignupSession(valkey: IORedis, data: SignupSession): Promise<string> {
  const sid = randomBytes(32).toString('base64url')
  await valkey.set(key(sid), JSON.stringify(data), 'EX', TTL_S)
  return sid
}

export async function readSignupSession(valkey: IORedis, sid: string | undefined): Promise<SignupSession | null> {
  if (!sid) return null
  const raw = await valkey.get(key(sid))
  if (!raw) return null
  try {
    return JSON.parse(raw) as SignupSession
  } catch {
    return null
  }
}

export async function destroySignupSession(valkey: IORedis, sid: string | undefined): Promise<void> {
  if (sid) await valkey.del(key(sid))
}
