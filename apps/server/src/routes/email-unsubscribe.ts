// #547 / ADR-196 §3 (S3): the emailed unsubscribe. The link carries a TENANT-BOUND `unsub+jwt`
// (packages/auth — its own typ, the token-confusion guard). The GET is a CONFIRMATION page and has NO
// side effects — every mail scanner prefetches links, and a mutating GET would unsubscribe its users;
// the pref flip is the POST, which is also exactly what RFC 8058 one-click (List-Unsubscribe-Post)
// sends. A tampered / expired / wrong-typ / WRONG-TENANT token is a uniform 404 (existence-hiding:
// the response never says which part failed). The flip touches exactly one (tenant, member, pref) —
// the token asserts that intent and nothing else.
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { verifyUnsubToken, type UnsubTokenClaims } from '@wikistead/auth'
import { getTenantBranding } from './branding.js'
import { esc } from '../email/layout.js'
import { productName } from '../product-name.js'
import { resolveMailLocale, type Lang } from '../locale.js'
import { tenantDefaultLang } from '../auth/session.js'
import {
  unsubBody, unsubHeading, unsubKindDigest, unsubKindMention, unsubTitle,
  unsubscribeButton, unsubscribedBody, unsubscribedTitle,
} from '../email/catalog.js'

/** #1008 / ADR-260 §3.1: the same three-step chain, resolved here rather than assumed English —
 * this is a request handler, not the outbox drain, so it reads the member directly off `req.db`
 * (already the correctly tenant-scoped connection every other read in this file uses). */
async function resolveLocale(req: FastifyRequest, sub: string): Promise<Lang> {
  const [row] = await req.db.sql<[{ locale: string | null }?]>`SELECT locale FROM members WHERE sub = ${sub} LIMIT 1`
  return resolveMailLocale(row?.locale ?? null, await tenantDefaultLang(req.db))
}

/** The tenant's display name, else the product's. Branding failures never block an unsubscribe. */
async function workspaceName(req: FastifyRequest): Promise<string> {
  try {
    const b = await getTenantBranding(req.db, req.tenant.plan)
    return b.displayName?.trim() || b.productName
  } catch {
    return productName()
  }
}

export async function emailUnsubscribePlugin(app: FastifyInstance) {
  const cfg = { secret: process.env.GUEST_TOKEN_SECRET!, ttlSeconds: 0 /* verify-only here */ }

  const claimsOf = async (req: FastifyRequest): Promise<UnsubTokenClaims | null> => {
    const token = (req.query as { token?: string } | undefined)?.token
    if (!token) return null
    let claims: UnsubTokenClaims
    try {
      claims = await verifyUnsubToken(cfg, token)
    } catch {
      return null // tampered / expired / wrong typ — all the same 404
    }
    // tenant binding: the Host-resolved tenant must be the one the token was minted for
    if (claims.tenantId !== req.tenant.id) return null
    if (claims.action !== 'immediate' && claims.action !== 'digest') return null
    return claims
  }

  // GET: confirmation only. Renders a minimal self-contained page whose ONLY action is the POST form.
  app.get<{ Querystring: { token?: string } }>('/email/unsubscribe', { config: { public: true } }, async (req, reply) => {
    const claims = await claimsOf(req)
    if (!claims) return reply.code(404).send({ error: 'not found' })
    const lang = await resolveLocale(req, claims.sub)
    // `kind` is one of two fixed catalog strings — never user input, no escaping needed.
    const kind = claims.action === 'immediate' ? unsubKindMention(lang) : unsubKindDigest(lang)
    const action = `/email/unsubscribe?token=${encodeURIComponent((req.query as { token?: string }).token!)}`
    // #575 slice B: the page says WHICH workspace is being left. It is a raw template on the same
    // origin as the session cookie (ADR-016) and the display name is stored with only a trim and a
    // length cap, so every interpolation of it here goes through `esc` — the shared one, so this page
    // and the mails cannot drift apart on what escaping means.
    const brand = esc(await workspaceName(req))
    return reply.type('text/html').send(`<!doctype html>
<html><head><meta charset="utf-8"><title>${unsubTitle(lang, brand)}</title></head>
<body style="font-family:sans-serif;max-width:32rem;margin:4rem auto">
<p style="color:#666;font-size:0.9rem;margin:0 0 0.5rem">${brand}</p>
<h1 style="font-size:1.2rem">${unsubHeading(lang, kind)}</h1>
<p>${unsubBody(lang, kind, brand)}</p>
<form method="post" action="${esc(action)}"><button type="submit">${unsubscribeButton(lang)}</button></form>
</body></html>`)
  })

  // POST: the flip. Accepts both the confirmation-page form and the RFC 8058 one-click POST (its
  // `List-Unsubscribe=One-Click` form body is irrelevant — the token in the URL carries the intent).
  app.post<{ Querystring: { token?: string } }>('/email/unsubscribe', { config: { public: true } }, async (req, reply) => {
    const claims = await claimsOf(req)
    if (!claims) return reply.code(404).send({ error: 'not found' })
    const col = claims.action === 'immediate' ? 'email_immediate' : 'email_digest'
    // RLS-scoped handle: the UPDATE can only ever touch this tenant's row for this sub
    await req.db.sql`UPDATE members SET ${req.db.sql(col)} = false WHERE sub = ${claims.sub}`
    const lang = await resolveLocale(req, claims.sub)
    const brand = esc(await workspaceName(req))
    return reply.type('text/html').send(`<!doctype html><html><head><meta charset="utf-8"><title>${unsubscribedTitle(lang)}</title></head><body style="font-family:sans-serif;max-width:32rem;margin:4rem auto"><p style="color:#666;font-size:0.9rem;margin:0 0 0.5rem">${brand}</p><p>${unsubscribedBody(lang)}</p></body></html>`)
  })
}
