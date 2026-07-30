// #547 / ADR-196 §4: the canonical tenant base URL for links built OFF the request path. Every link
// the app ships today comes from `req.headers.host`; the outbox drain has no request, so it needs a
// deployment-level answer. Order: the tenant's VERIFIED custom domain (ADR-065) wins; else the tenant
// slug is prefixed onto WKS_PUBLIC_BASE_URL (scheme + root host, e.g. https://wikistead.example.com →
// https://<slug>.wikistead.example.com). No env → null: the caller must degrade honestly (a mail with
// no link is not sent with an improvised one).
import type postgres from 'postgres'

export function composeTenantUrl(slug: string, publicBaseUrl: string | undefined): string | null {
  if (!publicBaseUrl) return null
  let u: URL
  try {
    u = new URL(publicBaseUrl)
  } catch {
    return null
  }
  // host (not hostname): the port must survive — dev deployments live on :5173-style hosts
  return `${u.protocol}//${slug}.${u.host}`
}

export async function tenantBaseUrl(
  sql: postgres.Sql | { <T extends readonly object[]>(template: TemplateStringsArray, ...args: never[]): Promise<T> },
  tenant: { id: string; slug: string },
): Promise<string | null> {
  const domains = await (sql as postgres.Sql)<{ domain: string }[]>`
    SELECT domain FROM custom_domains WHERE tenant_id = ${tenant.id} AND status = 'verified' ORDER BY verified_at DESC LIMIT 1`
  if (domains.length > 0) return `https://${domains[0]!.domain}`
  return composeTenantUrl(tenant.slug, process.env.WKS_PUBLIC_BASE_URL)
}
