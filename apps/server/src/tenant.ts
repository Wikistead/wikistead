// Tenant resolution. The rest of the app is ISOLATION-METHOD-AGNOSTIC: business
// logic only ever sees a resolved Tenant + a scoped TenantDb handle. Whether the
// tenant lives in the shared DB (logical/RLS) or a dedicated namespace/instance
// is decided in acquireTenantDb — never in features.
import type { Tenant } from '@wikistead/types'
import { registry } from './db/index.js'

export function resolveTenantFromHost(host: string): { slug: string; domain: string } {
  const hostname = host.split(':')[0]
  return { slug: hostname.split('.')[0], domain: hostname }
}

// Custom domains take priority over subdomains so enterprise tenants can use
// their own vanity domain without it conflicting with slug routing.
export async function loadTenant(slug: string, domain: string): Promise<Tenant | null> {
  const byDomain = await registry.findByDomain(domain)
  if (byDomain) return byDomain
  return registry.findBySlug(slug)
}
