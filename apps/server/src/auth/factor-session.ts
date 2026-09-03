// The half-authenticated state between "your password was right" and "and here is your factor"
// (#652 slice 3 / ADR-219 §6).
//
// A SEPARATE COOKIE, on `signup-session.ts`'s pattern, and the ADR is explicit about why it is not a
// `pending: true` on `SessionData`: every route behind `app.ts`'s session guard reads that cookie, so a
// half-authenticated principal would be admitted everywhere by default and refused only where somebody
// remembered to check. Here the default is the other way round — nothing reads this cookie unless it
// opts in, and exactly two places do (present a factor, enrol one).
//
// It carries no groups, no role and no capabilities. It is not a session with a flag on it; it is a
// receipt saying "this password was correct, and the account has one thing left to prove".
import type IORedis from 'ioredis'
import { randomBytes } from 'node:crypto'
import type { FastifyRequest } from 'fastify'
import { isHttpsRequest } from './request-protocol.js'

export const FACTOR_COOKIE = 'wks_factor'
// Long enough to fetch a phone from another room, short enough that an abandoned one is not a standing
// half-credential. The enrolment case needs the longer end of that: installing an authenticator app is
// part of it.
const TTL_S = 600

export interface FactorSession {
  tenantId: string
  sub: string
  /** whether this member has a factor to PRESENT, or has to enrol one first (ADR-219 §6's circle) */
  enrolled: boolean
}

/**
 * `Path=/api` rather than `/`: it must reach the two routes that consume it and nothing else needs it.
 * A narrower path is not available — the enrolment and verification routes do not share a prefix
 * deeper than that — so the confinement that matters is the NAME: no other handler looks it up.
 *
 * #1091: `secure` follows the actual request protocol, not `NODE_ENV` — see session.ts.
 */
export function factorCookieOptions(req: Pick<FastifyRequest, 'headers' | 'protocol'>) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: isHttpsRequest(req),
    path: '/api',
    maxAge: TTL_S,
  }
}

const key = (sid: string) => `factorsess:${sid}`

export async function createFactorSession(valkey: IORedis, data: FactorSession): Promise<string> {
  const sid = randomBytes(32).toString('base64url')
  await valkey.set(key(sid), JSON.stringify(data), 'EX', TTL_S)
  return sid
}

export async function readFactorSession(valkey: IORedis, sid: string | undefined): Promise<FactorSession | null> {
  if (!sid) return null
  const raw = await valkey.get(key(sid))
  if (!raw) return null
  try {
    return JSON.parse(raw) as FactorSession
  } catch {
    return null
  }
}

/**
 * Spend it. Called the moment a full session is established, so the receipt cannot be presented twice —
 * a half-credential that outlives its use is a second way in for anybody who captured it.
 */
export async function destroyFactorSession(valkey: IORedis, sid: string | undefined): Promise<void> {
  if (sid) await valkey.del(key(sid))
}
