// #434 / ADR-170: the operator break-glass-ledger console — a SEPARATE fastify app, never mounted
// on (or importable into) the tenant app's route table. Cloud-only deployment (deploy/k8s prod
// overlay); CE/self-host keeps the CLI (operator-ledger-cli.ts). Read-only over a dedicated
// operator_ro connection (NOBYPASSRLS + role-scoped SELECT policy, migration 074) — NEVER the admin
// DSN: an HTTP workload must not hold BYPASSRLS.
//
// Authentication is two-layer (ADR-170 §2): an identity-aware proxy at the edge, and HERE the
// defense-in-depth layer that is sometimes the ONLY gate (port-forward is an admitted access path):
// a SIGNED identity token verified against a PINNED JWKS (env-provided, never fetched), then the
// sub against the OPERATOR_CONSOLE_SUBS allowlist. A bare unsigned header is never trusted.
// 401/403 carry no body detail (nothing to enumerate).
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import { createPublicKey, verify as cryptoVerify, type KeyObject } from 'node:crypto'
import type postgres from 'postgres'
import { readOperatorChain } from '../audit/operator-ledger.js'

// ---- pinned-JWKS compact-JWS verification (node:crypto only — no new dependency) ----------------
// Supports RS256 and ES256 (the two algs operator IdPs/proxies emit). Everything else — including
// `none` and the HS* family (which would turn the PUBLIC jwks into a symmetric secret) — is
// rejected outright. The JWKS is pinned configuration: key rotation is a redeploy, never a fetch.

export interface OperatorJwks { keys: Array<Record<string, unknown>> }

const ALGS: Record<string, { kty: string; pad?: 'ieee-p1363' }> = {
  RS256: { kty: 'RSA' },
  ES256: { kty: 'EC', pad: 'ieee-p1363' },
}

function b64urlJson(part: string): Record<string, unknown> | null {
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

// Import every usable JWKS key once at boot; a malformed key fails closed (skipped).
function importKeys(jwks: OperatorJwks): Array<{ kid: string | undefined; kty: string; key: KeyObject }> {
  const out: Array<{ kid: string | undefined; kty: string; key: KeyObject }> = []
  for (const jwk of jwks.keys ?? []) {
    try {
      const key = createPublicKey({ key: jwk as never, format: 'jwk' })
      out.push({ kid: typeof jwk.kid === 'string' ? jwk.kid : undefined, kty: String(jwk.kty ?? ''), key })
    } catch {
      /* fail closed: an unparseable key simply never verifies anything */
    }
  }
  return out
}

// Returns the verified `sub`, or null for ANY defect (format, alg, signature, exp, missing sub).
export function verifyOperatorToken(token: string, jwks: OperatorJwks, nowSec = Math.floor(Date.now() / 1000)): string | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const header = b64urlJson(parts[0]!)
  const payload = b64urlJson(parts[1]!)
  if (!header || !payload) return null
  const alg = typeof header.alg === 'string' ? header.alg : ''
  const spec = ALGS[alg]
  if (!spec) return null // `none`, HS*, and anything unexpected: rejected
  const keys = importKeys(jwks).filter((k) => k.kty === spec.kty)
  const kid = typeof header.kid === 'string' ? header.kid : undefined
  const candidates = kid ? keys.filter((k) => k.kid === kid) : keys
  if (candidates.length === 0) return null
  const data = Buffer.from(`${parts[0]}.${parts[1]}`)
  let sig: Buffer
  try {
    sig = Buffer.from(parts[2]!, 'base64url')
  } catch {
    return null
  }
  const ok = candidates.some((k) => {
    try {
      return cryptoVerify(
        'sha256',
        data,
        spec.pad ? { key: k.key, dsaEncoding: spec.pad } : k.key,
        sig,
      )
    } catch {
      return false
    }
  })
  if (!ok) return null
  const exp = typeof payload.exp === 'number' ? payload.exp : null
  if (exp === null || nowSec >= exp) return null // exp is REQUIRED — no non-expiring operator tokens
  const sub = typeof payload.sub === 'string' && payload.sub.length > 0 ? payload.sub : null
  return sub
}

// ---- the console app ----------------------------------------------------------------------------

export interface OperatorConsoleOpts {
  sql: postgres.Sql // an operator_ro connection (role-scoped SELECT on the ledger, INSERT on the access log)
  jwks: OperatorJwks // pinned verification keys (env JSON — never fetched)
  allowedSubs: string[] // OPERATOR_CONSOLE_SUBS
  now?: () => number // seconds; test seam for exp checks
}

interface LedgerRow {
  seq: string | number
  actor: string
  action: string
  target: string
  at: string
  prev_hash: string
  hash: string
}

export function buildOperatorApp(opts: OperatorConsoleOpts): FastifyInstance {
  const app = Fastify({ logger: false })
  const allowed = new Set(opts.allowedSubs)

  // Liveness probe only — no auth, no data.
  app.get('/healthz', async () => ({ ok: true }))

  // Auth for everything else. The verified sub rides the request for the access log.
  const requireOperator = async (req: FastifyRequest, reply: FastifyReply): Promise<string | undefined> => {
    const auth = req.headers.authorization
    const token = auth?.startsWith('Bearer ') ? auth.slice('Bearer '.length) : undefined
    const sub = token ? verifyOperatorToken(token, opts.jwks, opts.now?.()) : null
    if (!sub) {
      await reply.code(401).send({})
      return undefined
    }
    if (!allowed.has(sub)) {
      await reply.code(403).send({})
      return undefined
    }
    return sub
  }

  // Every console read is recorded — in the SEPARATE append-only access log, never the hash chain
  // (routine views must not bury break-glass entries; the console has zero ledger write access).
  const logAccess = async (sub: string, path: string): Promise<void> => {
    await opts.sql`INSERT INTO operator_console_access_log (sub, path) VALUES (${sub}, ${path})`
  }

  // Paged, newest-first view (a thin SELECT — the full-scan verify path stays readOperatorChain).
  app.get<{ Querystring: { limit?: string; before?: string } }>('/ledger', async (req, reply) => {
    const sub = await requireOperator(req, reply)
    if (!sub) return
    const limit = Math.min(Math.max(Number(req.query.limit ?? 50) || 50, 1), 200)
    const before = Number(req.query.before)
    const rows = Number.isFinite(before)
      ? await opts.sql<LedgerRow[]>`SELECT seq, actor, action, target, at, prev_hash, hash FROM operator_audit_log WHERE seq < ${before} ORDER BY seq DESC LIMIT ${limit}`
      : await opts.sql<LedgerRow[]>`SELECT seq, actor, action, target, at, prev_hash, hash FROM operator_audit_log ORDER BY seq DESC LIMIT ${limit}`
    await logAccess(sub, '/ledger')
    return {
      entries: rows.map((r) => ({
        seq: Number(r.seq),
        actor: r.actor,
        action: r.action,
        target: r.target,
        at: r.at,
        prevHash: r.prev_hash,
        hash: r.hash,
      })),
    }
  })

  // Chain verification — readOperatorChain/verifyAuditChain VERBATIM (the shared-implementation
  // pin: the console and the CLI can never disagree on the same data).
  app.get('/ledger/verify', async (req, reply) => {
    const sub = await requireOperator(req, reply)
    if (!sub) return
    const { entries, verdict } = await readOperatorChain(opts.sql)
    await logAccess(sub, '/ledger/verify')
    return { count: entries.length, tailHash: entries.at(-1)?.hash ?? null, verdict }
  })

  return app
}
