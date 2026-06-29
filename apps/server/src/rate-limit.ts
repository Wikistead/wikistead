import type IORedis from 'ioredis'

// Shared fixed-window rate limiter (#175 / ADR-063; the #107 share-link pattern generalized).
export const API_RATE_LIMIT_WINDOW_S = Number(process.env.API_RATE_LIMIT_WINDOW_S ?? 60)

// Atomic INCR + first-hit EXPIRE; returns whether still within `max`. `max === Infinity`
// short-circuits with NO Valkey round-trip — so the unlimited (self-host) path has zero overhead.
export async function bumpRateBucket(valkey: IORedis, key: string, max: number, windowS: number): Promise<boolean> {
  if (max === Infinity) return true
  const n = await valkey.incr(key)
  if (n === 1) await valkey.expire(key, windowS)
  return n <= max
}
