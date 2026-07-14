import type { Sql } from 'postgres'
import type { Tenant } from '@wikistead/types'
import { effectivePlan } from '../plan.js'

interface Row {
  id: string
  slug: string
  custom_domain: string | null
  isolation: 'logical' | 'namespace'
  plan: string
  pending_plan: string | null
  pending_plan_at: Date | null
}

interface CacheEntry { tenant: Tenant; expiresAt: number }

export class TenantRegistry {
  private readonly bySlug   = new Map<string, CacheEntry>()
  private readonly byDomain = new Map<string, CacheEntry>()
  private readonly byId     = new Map<string, CacheEntry>() // #382: withTenantTx resolves isolation by id
  private readonly ttl = 30_000

  constructor(private readonly sql: Sql) {}

  // #382: id lookup for the non-request contexts (outbox drains, doc-builder, token exchange…) that
  // only hold a tenantId. Same cache/TTL semantics as the slug/domain lookups.
  async findById(id: string): Promise<Tenant | null> {
    const hit = this.fromCache(this.byId, id)
    if (hit !== undefined) return hit
    const [row] = await this.sql<Row[]>`
      SELECT id, slug, custom_domain, isolation, plan, pending_plan, pending_plan_at
      FROM tenants WHERE id = ${id}
    `
    return this.store(row ?? null)
  }

  async findBySlug(slug: string): Promise<Tenant | null> {
    const hit = this.fromCache(this.bySlug, slug)
    if (hit !== undefined) return hit

    const [row] = await this.sql<Row[]>`
      SELECT id, slug, custom_domain, isolation, plan, pending_plan, pending_plan_at
      FROM tenants WHERE slug = ${slug}
    `
    return this.store(row ?? null)
  }

  async findByDomain(domain: string): Promise<Tenant | null> {
    const hit = this.fromCache(this.byDomain, domain)
    if (hit !== undefined) return hit

    const [row] = await this.sql<Row[]>`
      SELECT id, slug, custom_domain, isolation, plan, pending_plan, pending_plan_at
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
      // EFFECTIVE plan (#131 / ADR-064): during a downgrade's grace the old plan stays in
      // effect; past grace it's the new (lower) plan even before the reconcile batch commits.
      // Computed here so every downstream resolveEntitlements(tenant.plan) is the effective plan.
      // The 30s cache means a ≤30s lag at the (days-long) grace boundary — harmless; the batch
      // commits tenants.plan anyway, so it converges.
      plan: effectivePlan({ plan: row.plan, pendingPlan: row.pending_plan, pendingPlanAt: row.pending_plan_at }),
    }
    const entry: CacheEntry = { tenant, expiresAt: Date.now() + this.ttl }
    this.bySlug.set(tenant.slug, entry)
    this.byId.set(tenant.id, entry) // #382: keep the id cache warm from any lookup path
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
