// SSRF guard for server-side external fetch (#108/#140 · ADR-071/ADR-074). The IP classification
// + URL validation are the security core; verified with DISTINCT addresses (private/metadata/v6
// blocked, public allowed) and an injected resolver so no real DNS/network is needed.
import { describe, it, expect } from 'vitest'
import { isBlockedIp, assertSafeUrl, resolveGuarded, pinnedLookup, readCapped, guardedFetch } from '../safe-fetch.js'

async function* fromChunks(chunks: string[]): AsyncIterable<Uint8Array> {
  for (const c of chunks) yield new TextEncoder().encode(c)
}

describe('isBlockedIp (#108/#140 SSRF)', () => {
  it('blocks private / loopback / link-local / metadata / CGNAT', () => {
    for (const ip of ['10.0.0.1', '127.0.0.1', '192.168.1.1', '172.16.5.5', '172.31.255.255', '169.254.169.254', '100.64.0.1', '0.0.0.0']) {
      expect(isBlockedIp(ip), ip).toBe(true)
    }
  })
  it('blocks IPv6 loopback / ULA / link-local / IPv4-mapped-private', () => {
    for (const ip of ['::1', 'fc00::1', 'fd12::34', 'fe80::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1']) {
      expect(isBlockedIp(ip), ip).toBe(true)
    }
  })
  it('ALLOWS public addresses', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '93.184.216.34', '2606:4700:4700::1111', '::ffff:8.8.8.8']) {
      expect(isBlockedIp(ip), ip).toBe(false)
    }
  })
})

describe('assertSafeUrl (#108/#140 SSRF)', () => {
  const resolve = (ips: string[]) => async () => ips
  it('rejects non-https (no http/file/gopher SSRF)', async () => {
    await expect(assertSafeUrl('http://example.com', { resolve: resolve(['8.8.8.8']) })).rejects.toMatchObject({ code: 'scheme_blocked' })
    await expect(assertSafeUrl('file:///etc/passwd', { resolve: resolve(['8.8.8.8']) })).rejects.toMatchObject({ code: 'scheme_blocked' })
  })
  it('rejects an https host that resolves to a private/metadata IP (the SSRF case)', async () => {
    await expect(assertSafeUrl('https://evil.example', { resolve: resolve(['169.254.169.254']) })).rejects.toMatchObject({ code: 'ssrf_blocked' })
    await expect(assertSafeUrl('https://evil.example', { resolve: resolve(['8.8.8.8', '10.0.0.1']) })).rejects.toMatchObject({ code: 'ssrf_blocked' }) // ANY private IP blocks
  })
  it('allows https to a public host', async () => {
    const u = await assertSafeUrl('https://kroki.io/plantuml/svg/abc', { resolve: resolve(['93.184.216.34']) })
    expect(u.host).toBe('kroki.io')
  })
  it('rejects a malformed URL and an unresolvable host', async () => {
    await expect(assertSafeUrl('not a url', { resolve: resolve(['8.8.8.8']) })).rejects.toMatchObject({ code: 'invalid_url' })
    await expect(assertSafeUrl('https://nx.example', { resolve: resolve([]) })).rejects.toMatchObject({ code: 'dns_unresolved' })
  })
})

// ADR-083 / #181: tenant-OIDC issuer fetch hardening. The operator opt-in, IP pinning (DNS-rebinding
// defense), and bounded read are the security core — tested with distinct values and injected DNS.
describe('resolveGuarded — operator opt-in for private (ADR-083 #181)', () => {
  const resolve = (ips: string[]) => async () => ips
  it('rejects a private/metadata issuer by DEFAULT (no operator flag)', async () => {
    await expect(resolveGuarded('https://idp.evil', { resolve: resolve(['169.254.169.254']) })).rejects.toMatchObject({ code: 'ssrf_blocked' })
    await expect(resolveGuarded('https://idp.evil', { resolve: resolve(['10.0.0.5']) })).rejects.toMatchObject({ code: 'ssrf_blocked' })
  })
  it('PERMITS a private issuer ONLY when the operator opted in (self-host path)', async () => {
    const { url, ips } = await resolveGuarded('https://keycloak.internal', { resolve: resolve(['10.0.0.5']), allowPrivate: true })
    expect(url.host).toBe('keycloak.internal')
    expect(ips).toEqual(['10.0.0.5']) // returned for pinning
  })
  it('still requires https even with the operator flag (no http/file SSRF)', async () => {
    await expect(resolveGuarded('http://keycloak.internal', { resolve: resolve(['10.0.0.5']), allowPrivate: true })).rejects.toMatchObject({ code: 'scheme_blocked' })
  })
  it('returns the validated IPs so the connection can be pinned to them', async () => {
    const { ips } = await resolveGuarded('https://idp.example', { resolve: resolve(['93.184.216.34']) })
    expect(ips).toEqual(['93.184.216.34'])
  })
})

describe('pinnedLookup — DNS-rebinding defense (ADR-083 #181)', () => {
  it('hands back the pre-validated IP and NEVER re-resolves the hostname', () => {
    const lookup = pinnedLookup(['93.184.216.34'])
    let got: unknown
    // A rebinding attacker would flip the hostname to a private IP at connect time; the pinned lookup
    // ignores the hostname entirely, so the socket can only reach the IP we already validated.
    lookup('attacker-rebinds-to-127.0.0.1.example', undefined, (...a: unknown[]) => { got = a })
    expect(got).toEqual([null, '93.184.216.34', 4])
  })
  it('supports the all:true form (and infers IPv6 family)', () => {
    const lookup = pinnedLookup(['2606:4700:4700::1111'])
    let got: unknown
    lookup('idp.example', { all: true }, (...a: unknown[]) => { got = a })
    expect(got).toEqual([null, [{ address: '2606:4700:4700::1111', family: 6 }]])
  })
})

// #181 review (comment 347): the discovery-only fix left JWKS + token fetches unguarded — a legit
// public discovery doc could point jwks_uri/token_endpoint at an internal address. guardedFetch is the
// openid-client `customFetch` seam that re-validates EVERY issuer-derived fetch (discovery/jwks/token)
// with the SAME guard. The security core = it REFUSES to make the request when the target is
// non-https or resolves private (unless the operator opted in). Verified WITHOUT network via injected
// DNS: a blocked target rejects before any socket opens.
describe('guardedFetch — jwks/token fetches are guarded too (#181 review)', () => {
  const resolve = (ips: string[]) => async () => ips
  it('REFUSES an https jwks_uri/token_endpoint that resolves to an internal IP (the residual SSRF)', async () => {
    const f = guardedFetch({ resolve: resolve(['169.254.169.254']) })
    await expect(f('https://idp.example/jwks')).rejects.toMatchObject({ code: 'ssrf_blocked' })
    const f2 = guardedFetch({ resolve: resolve(['10.0.0.9']) })
    await expect(f2('https://idp.example/token', { method: 'POST', body: 'grant_type=authorization_code' })).rejects.toMatchObject({ code: 'ssrf_blocked' })
  })
  it('REFUSES a non-https jwks_uri (a discovery doc pointing http://internal/jwks)', async () => {
    const f = guardedFetch({ resolve: resolve(['8.8.8.8']) })
    await expect(f('http://idp.example/jwks')).rejects.toMatchObject({ code: 'scheme_blocked' })
  })
  it('PERMITS a private jwks/token target ONLY under the operator opt-in (self-hosted IdP key fetch)', async () => {
    // The flag must govern jwks/token too, not just discovery, or a self-hosted private IdP login breaks
    // at the key-fetch step. Prove the SSRF gate PASSES under allowPrivate without opening a real socket:
    // pass an already-aborted signal — the gate runs first (would throw ssrf_blocked if it rejected the
    // private IP), and only after passing does it honor the abort. So 'aborted' (not 'ssrf_blocked')
    // proves the private target was ACCEPTED by the guard under the operator flag.
    const aborted = AbortSignal.abort()
    const f = guardedFetch({ resolve: resolve(['10.0.0.5']), allowPrivate: true })
    await expect(f('https://keycloak.internal/jwks', { signal: aborted })).rejects.toMatchObject({ code: 'aborted' })
    // And WITHOUT the flag the same private target is refused BEFORE the abort is even considered.
    const g = guardedFetch({ resolve: resolve(['10.0.0.5']) })
    await expect(g('https://keycloak.internal/jwks', { signal: aborted })).rejects.toMatchObject({ code: 'ssrf_blocked' })
  })
})

describe('readCapped — bounded discovery read, no OOM (ADR-083 #181)', () => {
  it('returns the body when under the cap', async () => {
    expect(await readCapped(fromChunks(['{"ok":', 'true}']), 1024)).toBe('{"ok":true}')
  })
  it('refuses to buffer a body past the cap (rejects, does not OOM)', async () => {
    await expect(readCapped(fromChunks(['x'.repeat(200), 'y'.repeat(200)]), 256)).rejects.toMatchObject({ code: 'body_too_large' })
  })
})
