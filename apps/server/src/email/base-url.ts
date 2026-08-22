// #547 / ADR-196 §4: the canonical tenant base URL for links built OFF the request path. Every link
// the app ships today comes from `req.headers.host`; the outbox drain has no request, so it needs a
// deployment-level answer. Order: the tenant's VERIFIED custom domain (ADR-065) wins; else the tenant
// slug is prefixed onto WKS_PUBLIC_BASE_URL (scheme + root host, e.g. https://wikistead.example.com →
// https://<slug>.wikistead.example.com). No env → null: the caller must degrade honestly (a mail with
// no link is not sent with an improvised one).
import type postgres from 'postgres'

/**
 * #828 / ADR-254 Decision 5: the address, and — when there is none — WHICH step ran out.
 *
 * ⚠️ The old answer was a bare `string | null`, so the drain could only report the failure by naming
 * a variable. Naming a variable is not naming a step: an operator who set `WKS_PUBLIC_BASE_URL` to
 * something unparseable got the same sentence as one who never set it, and the two need different
 * actions. `ranOut` is the ordered list of steps that were tried and gave nothing.
 *
 * ⚠️ A LIST rather than a finished sentence, for two reasons. Slice 3 (the ADR-249 template branch,
 * held until #123) inserts a step in the middle — with a list that is one array entry, with prose it
 * is a rewrite of every string. And a pin can count the steps, which prose cannot be asked.
 */
export interface TenantAddress {
  url: string | null
  ranOut: readonly string[]
}

/**
 * The sentence the drain logs. Reads "no verified custom domain, no WKS_PUBLIC_BASE_URL, so no link"
 * — the ADR's wording, three clauses today and four once slice 3 lands.
 */
export function noAddressReason(a: TenantAddress): string {
  return `${a.ranOut.join(', ')}, so no link`
}

export function composeTenantUrl(slug: string, publicBaseUrl: string | undefined): string | null {
  return composeStep(slug, publicBaseUrl).url
}

// The second step, with its own reason. `composeTenantUrl` stays exported for the callers that only
// want the address (and for the pins that measure the composition itself).
function composeStep(slug: string, publicBaseUrl: string | undefined): TenantAddress {
  if (!publicBaseUrl) return { url: null, ranOut: ['no WKS_PUBLIC_BASE_URL'] }
  let u: URL
  try {
    u = new URL(publicBaseUrl)
  } catch {
    // ⚠️ A DIFFERENT step from the one above, and deliberately so: the operator did declare an
    // address and it is not one. Reporting this as "unset" sends them looking for a missing line.
    return { url: null, ranOut: ['WKS_PUBLIC_BASE_URL is not a URL'] }
  }
  // host (not hostname): the port must survive — dev deployments live on :5173-style hosts
  return { url: `${u.protocol}//${slug}.${u.host}`, ranOut: [] }
}

export async function tenantBaseUrl(
  sql: postgres.Sql | { <T extends readonly object[]>(template: TemplateStringsArray, ...args: never[]): Promise<T> },
  tenant: { id: string; slug: string },
): Promise<TenantAddress> {
  const domains = await (sql as postgres.Sql)<{ domain: string }[]>`
    SELECT domain FROM custom_domains WHERE tenant_id = ${tenant.id} AND status = 'verified' ORDER BY verified_at DESC LIMIT 1`
  if (domains.length > 0) return { url: `https://${domains[0]!.domain}`, ranOut: [] }
  const composed = composeStep(tenant.slug, process.env.WKS_PUBLIC_BASE_URL)
  return { url: composed.url, ranOut: composed.url ? [] : ['no verified custom domain', ...composed.ranOut] }
}
