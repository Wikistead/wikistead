// #331 / ADR-138 (C-6): a pseudonymous per-session id minted into the guest token claim. Increment 1 is INERT
// (the id rides the token; attribution/presence/parser is increment 2), so this pins the mint + claim shape.
import { describe, it, expect } from 'vitest'
import { deriveAnonId, mintGuestToken, verifyGuestToken } from '@wikistead/auth'

const cfg = { secret: process.env.GUEST_TOKEN_SECRET || 'test-secret-for-anon-id', ttlSeconds: 300 }
const args = { tenantId: 'tenant_dev', shareLinkId: 'sl1', resource: { type: 'page' as const, id: 'p1' }, capability: 'view' as const }

describe('deriveAnonId / guest anonId (#331 / ADR-138)', () => {
  it('deriveAnonId is `anon:` + exactly 12 hex chars', () => {
    const id = deriveAnonId(cfg.secret)
    expect(id).toMatch(/^anon:[0-9a-f]{12}$/)
  })

  it('a fresh derive is unique each time (CSPRNG nonce — not derived from any stable/PII input)', () => {
    const ids = new Set(Array.from({ length: 50 }, () => deriveAnonId(cfg.secret)))
    expect(ids.size).toBe(50) // no collisions across 50 derives
  })

  it('mintGuestToken embeds an anonId in the claim; verify round-trips it', async () => {
    const token = await mintGuestToken(cfg, args)
    const claims = await verifyGuestToken(cfg, token)
    expect(claims.anonId).toMatch(/^anon:[0-9a-f]{12}$/)
    // the FGA principal is unchanged — anonId is metadata only, not a capability (authz invariant).
    expect(claims.shareLinkId).toBe('sl1')
    expect(claims.capability).toBe('view')
  })

  it('a fresh exchange gets a NEW pseudonym; a silent refresh can carry the SAME one (one session = one pseudonym)', async () => {
    const a = await verifyGuestToken(cfg, await mintGuestToken(cfg, args))
    const b = await verifyGuestToken(cfg, await mintGuestToken(cfg, args))
    expect(a.anonId).not.toBe(b.anonId) // two independent exchanges → distinct pseudonyms
    // a refresh that PASSES the existing anonId keeps it stable (invariant 4)
    const refreshed = await verifyGuestToken(cfg, await mintGuestToken(cfg, { ...args, anonId: a.anonId }))
    expect(refreshed.anonId).toBe(a.anonId)
  })
})
