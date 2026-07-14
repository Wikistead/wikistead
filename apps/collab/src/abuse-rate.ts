// #328 / ADR-140 increment 2: guest CONNECT rate caps for the collab join point. Bounds connection /
// reconnect flooding per share LINK and per #331 pseudonymous SESSION — never raw IP (ADR-140 I1 /
// ADR-138). Enforced AFTER authenticate() (an unauthorized token never reaches a bucket, so the limiter
// can't become a pre-auth probe); it only ever REJECTS an already-authorized join, never grants one.
// Defaults are NULL = unlimited: one cheap RLS-scoped SELECT and the Infinity short-circuit does no
// Valkey I/O, so a self-host tenant with the knobs unset pays ~nothing per connect.
import type IORedis from "ioredis";
import { withTenant } from "./db.js";

const WINDOW_S = Number(process.env.API_RATE_LIMIT_WINDOW_S ?? 60);

// The ADR-063 fixed-window bucket (apps/server rate-limit.ts), replicated here because the collab
// server cannot import from apps/server. Atomic INCR + first-hit EXPIRE; `max === Infinity`
// short-circuits with NO Valkey round-trip.
export async function bumpRateBucket(valkey: IORedis, key: string, max: number, windowS: number): Promise<boolean> {
  if (max === Infinity) return true;
  const n = await valkey.incr(key);
  if (n === 1) await valkey.expire(key, windowS);
  return n <= max;
}

// NULL/unset or nonsensical (≤0 would block every join; no config UI in this increment) = unlimited —
// the same clamp discipline as the publish-side filter (abuse-filter.ts shrink-ratio guard).
export function normalizeRateMax(max: number | null | undefined): number {
  return max != null && max > 0 ? max : Infinity;
}

export interface ConnectCaps {
  linkMax: number;
  sessionMax: number;
}

export async function readConnectCaps(tenantId: string): Promise<ConnectCaps> {
  const rows = await withTenant(tenantId, (sql) => sql<{ abuse_connect_rate_link_max: number | null; abuse_connect_rate_session_max: number | null }[]>`
    SELECT abuse_connect_rate_link_max, abuse_connect_rate_session_max FROM tenant_settings WHERE tenant_id = ${tenantId}
  `);
  const row = rows[0];
  return { linkMax: normalizeRateMax(row?.abuse_connect_rate_link_max), sessionMax: normalizeRateMax(row?.abuse_connect_rate_session_max) };
}

// True = within budget. The per-LINK bucket bounds the whole link; the per-SESSION bucket bounds one
// guest within it (skipped for a pre-#331 token with no anonId — the link bucket still applies).
export async function guestConnectRateAllowed(
  valkey: IORedis,
  caps: ConnectCaps,
  id: { tenantId: string; shareLinkId: string; anonId?: string },
): Promise<boolean> {
  const okLink = await bumpRateBucket(valkey, `rl:abuse:conn:link:${id.tenantId}:${id.shareLinkId}`, caps.linkMax, WINDOW_S);
  const okSession = id.anonId
    ? await bumpRateBucket(valkey, `rl:abuse:conn:anon:${id.tenantId}:${id.anonId}`, caps.sessionMax, WINDOW_S)
    : true;
  return okLink && okSession;
}
