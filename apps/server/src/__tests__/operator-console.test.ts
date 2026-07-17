// #434 / ADR-170 — the operator break-glass-ledger console. Security-critical pins:
//   * the TENANT app has no /ledger routes (structural unreachability, inventory + behavioral);
//   * app-layer auth is cryptographic — no token / forged signature / expired → 401, a valid
//     token whose sub is not allowlisted → 403, allowlisted → data (and `none`/HS* rejected);
//   * verify shares readOperatorChain/verifyAuditChain with the CLI (same data ⇒ same verdict);
//   * a console read appends to the SEPARATE access log and leaves the hash chain byte-identical;
//   * operator_ro containment (migration 074): ledger SELECT works via the role-scoped policy,
//     ledger writes and tenant-table reads are denied, and the app role still reads ZERO rows.
import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { createHash, generateKeyPairSync, sign as cryptoSign } from 'node:crypto'
import postgres from 'postgres'
import { buildOperatorApp, verifyOperatorToken, type OperatorJwks } from '../operator/app.js'
import { appendOperatorEntry, readOperatorChain } from '../audit/operator-ledger.js'
import { verifyAuditChain } from '../audit/chain.js'
import { formatLedger } from '../audit/operator-ledger-cli.js'

const admin = postgres(process.env.DATABASE_ADMIN_URL!) // superuser (test harness only — the console never sees it)
// The console's connection: the admin DSN with the role DOWNGRADED to operator_ro for the session,
// which is exactly what a dedicated operator_ro LOGIN member resolves to (NOBYPASSRLS + the
// role-scoped policies of migration 074).
const opRo = postgres(process.env.DATABASE_ADMIN_URL!, { connection: { options: '-c role=operator_ro' }, onnotice: () => {} })
const appRole = postgres(process.env.DATABASE_URL!)

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const jwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>
const jwks: OperatorJwks = { keys: [{ ...jwk, kid: 'test-op-key' }] }
const { privateKey: strangerKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })

const b64url = (v: Buffer | string): string => Buffer.from(v).toString('base64url')
function signToken(opts: { sub?: string; expOffsetSec?: number; alg?: string; key?: typeof privateKey; kid?: string }): string {
  const header = { alg: opts.alg ?? 'RS256', kid: opts.kid ?? 'test-op-key' }
  const payload: Record<string, unknown> = { exp: Math.floor(Date.now() / 1000) + (opts.expOffsetSec ?? 300) }
  if (opts.sub !== undefined) payload.sub = opts.sub
  const data = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`
  const sig = cryptoSign('sha256', Buffer.from(data), opts.key ?? privateKey)
  return `${data}.${b64url(sig)}`
}

const app = buildOperatorApp({ sql: opRo, jwks, allowedSubs: ['ops-alice', 'ops-bob'] })

beforeAll(async () => {
  // Seed at least one real chained entry so reads/verify have material.
  await admin.begin((tx) =>
    appendOperatorEntry(tx, { actor: 'operator:console-test', action: 'tenant.oidc_recovered', target: 'tenant:console-t', at: '2026-07-18T00:00:00.000Z' }),
  )
})
afterAll(async () => {
  await app.close()
  await admin.end()
  await opRo.end()
  await appRole.end()
})

describe('operator console (#434 / ADR-170)', () => {
  it('healthz is open; ledger routes are cryptographically gated (401/403 matrix)', async () => {
    expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200)
    // no token
    expect((await app.inject({ method: 'GET', url: '/ledger' })).statusCode).toBe(401)
    // a bare identity header is NEVER trusted (the port-forward path has no proxy in front)
    expect((await app.inject({ method: 'GET', url: '/ledger', headers: { 'x-forwarded-user': 'ops-alice' } })).statusCode).toBe(401)
    // forged signature (right shape, wrong key)
    const forged = signToken({ sub: 'ops-alice', key: strangerKey })
    expect((await app.inject({ method: 'GET', url: '/ledger', headers: { authorization: `Bearer ${forged}` } })).statusCode).toBe(401)
    // expired
    const expired = signToken({ sub: 'ops-alice', expOffsetSec: -60 })
    expect((await app.inject({ method: 'GET', url: '/ledger', headers: { authorization: `Bearer ${expired}` } })).statusCode).toBe(401)
    // valid signature, sub not allowlisted
    const outsider = signToken({ sub: 'ops-mallory' })
    expect((await app.inject({ method: 'GET', url: '/ledger', headers: { authorization: `Bearer ${outsider}` } })).statusCode).toBe(403)
    // allowlisted → rows
    const ok = await app.inject({ method: 'GET', url: '/ledger?limit=5', headers: { authorization: `Bearer ${signToken({ sub: 'ops-alice' })}` } })
    expect(ok.statusCode).toBe(200)
    const body = ok.json() as { entries: Array<{ seq: number; actor: string; hash: string }> }
    expect(body.entries.length).toBeGreaterThan(0)
    expect(body.entries.length).toBeLessThanOrEqual(5)
    expect(body.entries[0]!.actor).toMatch(/^operator:/)
  })

  it('rejects alg confusion: `none` and HS256 (public JWKS must never become a shared secret)', () => {
    const noneTok = `${b64url(JSON.stringify({ alg: 'none' }))}.${b64url(JSON.stringify({ sub: 'ops-alice', exp: 9999999999 }))}.`
    expect(verifyOperatorToken(noneTok, jwks)).toBeNull()
    // HS256 "signed" with the public key bytes — the classic downgrade; must not even be attempted
    const hsData = `${b64url(JSON.stringify({ alg: 'HS256', kid: 'test-op-key' }))}.${b64url(JSON.stringify({ sub: 'ops-alice', exp: 9999999999 }))}`
    const fakeMac = createHash('sha256').update(hsData).digest()
    expect(verifyOperatorToken(`${hsData}.${b64url(fakeMac)}`, jwks)).toBeNull()
    // missing sub fails
    expect(verifyOperatorToken(signToken({ sub: undefined }), jwks)).toBeNull()
  })

  it('verify shares the CLI implementation (same data ⇒ same verdict) and the read is non-destructive', async () => {
    const before = await readOperatorChain(admin)
    const accessBefore = Number((await admin`SELECT count(*)::int AS n FROM operator_console_access_log`)[0]!.n)

    const res = await app.inject({ method: 'GET', url: '/ledger/verify', headers: { authorization: `Bearer ${signToken({ sub: 'ops-bob' })}` } })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { count: number; tailHash: string | null; verdict: { valid: boolean } }
    expect(body.verdict.valid).toBe(true)
    expect(body.count).toBe(before.entries.length)
    expect(body.tailHash).toBe(before.entries.at(-1)!.hash)
    // CLI parity on the same data
    expect(formatLedger(before, false).ok).toBe(body.verdict.valid)
    expect(verifyAuditChain(before.entries).valid).toBe(body.verdict.valid)

    // the hash chain is byte-identical after console reads…
    const after = await readOperatorChain(admin)
    expect(after.entries).toEqual(before.entries)
    // …and the access log (SEPARATE, append-only) recorded the reads with the verified sub
    const accessAfter = await admin<{ sub: string; path: string }[]>`
      SELECT sub, path FROM operator_console_access_log ORDER BY id DESC LIMIT 3
    `
    expect(Number((await admin`SELECT count(*)::int AS n FROM operator_console_access_log`)[0]!.n)).toBeGreaterThan(accessBefore)
    expect(accessAfter.some((r) => r.sub === 'ops-bob' && r.path === '/ledger/verify')).toBe(true)
  })

  it('pages newest-first with the before cursor', async () => {
    await admin.begin((tx) =>
      appendOperatorEntry(tx, { actor: 'operator:console-test2', action: 'tenant.oidc_recovered', target: 'tenant:console-u', at: '2026-07-18T00:00:01.000Z' }),
    )
    const auth = { authorization: `Bearer ${signToken({ sub: 'ops-alice' })}` }
    const page1 = (await app.inject({ method: 'GET', url: '/ledger?limit=1', headers: auth })).json() as { entries: Array<{ seq: number }> }
    expect(page1.entries.length).toBe(1)
    const page2 = (await app.inject({ method: 'GET', url: `/ledger?limit=1&before=${page1.entries[0]!.seq}`, headers: auth })).json() as { entries: Array<{ seq: number }> }
    expect(page2.entries.length).toBe(1)
    expect(page2.entries[0]!.seq).toBeLessThan(page1.entries[0]!.seq)
  })

  it('operator_ro containment: ledger SELECT only; no ledger writes; no tenant tables; app role still denied', async () => {
    // the role-scoped SELECT policy works
    const rows = await opRo`SELECT seq FROM operator_audit_log ORDER BY seq DESC LIMIT 1`
    expect(rows.length).toBe(1)
    // NOBYPASSRLS is retained by the downgraded session (sanity for the whole containment claim)
    const who = await opRo`SELECT current_user`
    expect(who[0]!.current_user).toBe('operator_ro')
    // ledger writes: no grant, no policy → denied
    await expect(opRo`INSERT INTO operator_audit_log (seq, actor, action, target, at, prev_hash, hash) VALUES (999999, 'x', 'x', '', 'x', '', 'x')`).rejects.toThrow(/permission denied/i)
    await expect(opRo`UPDATE operator_audit_log SET actor = 'x' WHERE seq = 1`).rejects.toThrow(/permission denied/i)
    await expect(opRo`DELETE FROM operator_audit_log WHERE seq = 1`).rejects.toThrow(/permission denied/i)
    // tenant tables: unreachable
    await expect(opRo`SELECT id FROM pages LIMIT 1`).rejects.toThrow(/permission denied/i)
    // the access log is INSERT-only for the console role (reading it back is an admin task)
    await expect(opRo`SELECT sub FROM operator_console_access_log LIMIT 1`).rejects.toThrow(/permission denied/i)
    // the app role still reads ZERO ledger rows after the 074 policy amendment (047 default-deny re-pinned)
    await expect(appRole`SELECT seq FROM operator_audit_log LIMIT 1`).rejects.toThrow(/permission denied/i)
    await expect(appRole`SELECT sub FROM operator_console_access_log LIMIT 1`).rejects.toThrow(/permission denied/i)
  })

  it('the TENANT app has no operator routes (structural unreachability inventory)', async () => {
    // Behavioral: the tenant app 404s the operator paths (uniform not-found — nothing to probe).
    // Inventory: its printed route table contains no ledger entries. buildApp is heavy; import it
    // lazily so this file's other tests never pay for it on a focused run.
    const { buildApp } = await import('../app.js')
    const tenant = await buildApp()
    try {
      expect(tenant.printRoutes({ commonPrefix: false })).not.toMatch(/ledger/i)
      const res = await tenant.inject({ method: 'GET', url: '/ledger' })
      expect(res.statusCode).toBe(404)
      const res2 = await tenant.inject({ method: 'GET', url: '/api/ledger' })
      expect(res2.statusCode).toBe(404)
    } finally {
      await tenant.close()
    }
  })
})
