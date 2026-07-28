// #235 / ADR-065: a TLS certificate is issued for a custom domain ONLY after DNS ownership is verified.
// That rule has been written in a comment since #123; issuing for an unproven host is how a tenant gets a
// certificate for a domain it does not own, so it is pinned here as behaviour instead.
import { describe, it, expect } from 'vitest'
import {
  renderCustomDomainCertificate, renderCustomDomainCertificates, certObjectsToDelete, certNameFor, secretNameFor,
} from '../deploy/cert-manifest.js'

const OPTS = { namespace: 'wikistead', issuer: 'letsencrypt-prod' }
const row = (over: Partial<{ domain: string; status: string; tenantId: string }> = {}) => ({
  domain: 'docs.example.com', status: 'verified', tenantId: 'tenant_dev', ...over,
})

describe('#235 custom-domain certificates', () => {
  it('renders a Certificate for a verified domain', () => {
    const c = renderCustomDomainCertificate(row(), OPTS)!
    expect(c.kind).toBe('Certificate')
    expect(c.spec.dnsNames, 'exactly the domain that was proven — never a wildcard').toEqual(['docs.example.com'])
    expect(c.spec.issuerRef).toEqual({ name: 'letsencrypt-prod', kind: 'ClusterIssuer' })
    expect(c.metadata.namespace).toBe('wikistead')
  })

  it('renders NOTHING for a domain whose ownership is unproven', () => {
    for (const status of ['pending', 'verifying', 'failed', 'revoked', '']) {
      expect(renderCustomDomainCertificate(row({ status }), OPTS), `status=${status} must not get a certificate`).toBeNull()
    }
  })

  it('a mixed list yields certificates only for the verified rows', () => {
    const out = renderCustomDomainCertificates(
      [row({ domain: 'a.example.com' }), row({ domain: 'b.example.com', status: 'pending' }), row({ domain: 'c.example.com' })],
      OPTS,
    )
    expect(out.map((c) => c.spec.dnsNames[0])).toEqual(['a.example.com', 'c.example.com'])
  })

  it('refuses a malformed domain outright rather than emitting a broken object', () => {
    for (const domain of ['not a domain', 'https://x.example.com', 'x.example.com/path', 'UPPER.example.com/']) {
      expect(() => renderCustomDomainCertificate(row({ domain }), OPTS), domain).toThrow(/malformed domain/)
    }
  })

  it('carries the tenant on a label so a revoke can find it without parsing names', () => {
    const c = renderCustomDomainCertificate(row({ tenantId: 'tenant_acme' }), OPTS)!
    expect(c.metadata.labels['wikistead.io/tenant']).toBe('tenant_acme')
    expect(c.metadata.labels['wikistead.io/custom-domain']).toBe('docs.example.com')
  })

  it('a revoke deletes the Secret too — key material must not outlive the domain', () => {
    const objs = certObjectsToDelete('docs.example.com', 'wikistead')
    expect(objs.map((o) => o.kind).sort(), 'both, or the key is left behind for the next owner').toEqual(['Certificate', 'Secret'])
    expect(objs.find((o) => o.kind === 'Certificate')!.name).toBe(certNameFor('docs.example.com'))
    expect(objs.find((o) => o.kind === 'Secret')!.name).toBe(secretNameFor('docs.example.com'))
  })

  it('two tenants asking for different domains never collide on a name', () => {
    const a = renderCustomDomainCertificate(row({ domain: 'a.example.com', tenantId: 't1' }), OPTS)!
    const b = renderCustomDomainCertificate(row({ domain: 'b.example.com', tenantId: 't2' }), OPTS)!
    expect(a.metadata.name).not.toBe(b.metadata.name)
    expect(a.spec.secretName).not.toBe(b.spec.secretName)
  })
})
