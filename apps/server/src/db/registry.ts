import type { Sql } from 'postgres'
import type { Tenant } from '@kb/types'

interface Row {
  id: string
  slug: string
  custom_domain: string | null
  isolation: 'logical' | 'namespace'
  plan: string
}

interface CacheEntry { tenant: Tenant; expiresAt: number }

export class TenantRegistry {
  private readonly bySlug   = new Map<string, CacheEntry>()
  private readonly byDomain = new Map<string, CacheEntry>()
  private readonly ttl = 30_000

  constructor(private readonly sql: Sql) {}

  async findBySlug(slug: string): Promise<Tenant | null> {
    const hit = this.fromCache(this.bySlug, slug)
    if (hit !== undefined) return hit

    const [row] = await this.sql<Row[]>`
      SELECT id, slug, custom_domain, isolation, plan
      FROM tenants WHERE slug = ${slug}
    `
    return this.store(row ?? null)
  }

  async findByDomain(domain: string): Promise<Tenant | null> {
    const hit = this.fromCache(this.byDomain, domain)
    if (hit !== undefined) return hit

    const [row] = await this.sql<Row[]>`
      SELECT id, slug, custom_domain, isolation, plan
      FROM tenants WHERE custom_domain = ${domain}
    `
    return this.store(row ?? null)
  }

  private store(row: Row | null): Tenant | null {
    if (!row) return null
    const tenant: Tenant = {
      id: row.id,
      slug: row.slug,
      customDomain: row.custom_domain ?? undefined,
      isolation: row.isolation,
      plan: row.plan,
    }
    const entry: CacheEntry = { tenant, expiresAt: Date.now() + this.ttl }
    this.bySlug.set(tenant.slug, entry)
    if (tenant.customDomain) this.byDomain.set(tenant.customDomain, entry)
    return tenant
  }

  private fromCache(map: Map<string, CacheEntry>, key: string): Tenant | null | undefined {
    const entry = map.get(key)
    if (!entry) return undefined
    if (Date.now() > entry.expiresAt) { map.delete(key); return undefined }
    return entry.tenant
  }
}
