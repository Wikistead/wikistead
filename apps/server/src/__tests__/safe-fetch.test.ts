// SSRF guard for server-side external fetch (#108/#140 · ADR-071/ADR-074). The IP classification
// + URL validation are the security core; verified with DISTINCT addresses (private/metadata/v6
// blocked, public allowed) and an injected resolver so no real DNS/network is needed.
import { describe, it, expect } from 'vitest'
import { isBlockedIp, assertSafeUrl } from '../safe-fetch.js'

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
