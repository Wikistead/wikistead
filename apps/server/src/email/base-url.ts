// #547 / ADR-196 §4: the canonical tenant base URL for links built OFF the request path. Every link
// the app ships today comes from `req.headers.host`; the outbox drain has no request, so it needs a
// deployment-level answer. Order: the tenant's VERIFIED custom domain (ADR-065) wins; else
// WKS_TENANT_URL_TEMPLATE (#1114 / ADR-249 slice 3, held until #123 — a deployment already declares
// this shape for self-serve creation, and a second, independently-composed answer for mail is the
// "same fact declared twice" ADR-260 §2 warns against); else the tenant slug is prefixed onto
// WKS_PUBLIC_BASE_URL (scheme + root host, e.g. https://wikistead.example.com →
// https://<slug>.wikistead.example.com). No env → null: the caller must degrade honestly (a mail with
// no link is not sent with an improvised one).
import type postgres from 'postgres'
import { readTenantUrlTemplate } from '../auth/tenant-url-template.js'

/**
 * #828 / ADR-254 Decision 5: the address, and — when there is none — WHICH step ran out.
 *
 * ⚠️ The old answer was a bare `string | null`, so the drain could only report the failure by naming
 * a variable. Naming a variable is not naming a step: an operator who set `WKS_PUBLIC_BASE_URL` to
 * something unparseable got the same sentence as one who never set it, and the two need different
 * actions. `ranOut` is the ordered list of steps that were tried and gave nothing.
 *
 * ⚠️ A LIST rather than a finished sentence, for two reasons. Slice 3 (#1114 / the ADR-249 template
 * branch) inserted a step in the middle — with a list that is one array entry, with prose it would
 * have been a rewrite of every string. And a pin can count the steps, which prose cannot be asked.
 */
export interface TenantAddress {
  url: string | null
  ranOut: readonly string[]
}

/**
 * The sentence the drain logs. Reads "no verified custom domain, WKS_TENANT_URL_TEMPLATE is not set,
 * no WKS_PUBLIC_BASE_URL, so no link" when all three steps ran out.
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

// Slice 3: WKS_TENANT_URL_TEMPLATE's own placeholder-shape checks already exist
// (auth/tenant-url-template.ts) — reused here rather than re-validated, so a template that is good
// enough to serve a real workspace is also good enough to address a mail.
function templateStep(slug: string): TenantAddress {
  const t = readTenantUrlTemplate()
  return t.ok ? { url: t.render(slug), ranOut: [] } : { url: null, ranOut: [t.why] }
}

export async function tenantBaseUrl(
  sql: postgres.Sql | { <T extends readonly object[]>(template: TemplateStringsArray, ...args: never[]): Promise<T> },
  tenant: { id: string; slug: string },
): Promise<TenantAddress> {
  const domains = await (sql as postgres.Sql)<{ domain: string }[]>`
    SELECT domain FROM custom_domains WHERE tenant_id = ${tenant.id} AND status = 'verified' ORDER BY verified_at DESC LIMIT 1`
  if (domains.length > 0) return { url: `https://${domains[0]!.domain}`, ranOut: [] }
  const template = templateStep(tenant.slug)
  if (template.url) return template
  const composed = composeStep(tenant.slug, process.env.WKS_PUBLIC_BASE_URL)
  if (composed.url) return composed
  return { url: null, ranOut: ['no verified custom domain', ...template.ranOut, ...composed.ranOut] }
}
