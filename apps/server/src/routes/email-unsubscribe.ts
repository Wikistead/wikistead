// #547 / ADR-196 §3 (S3): the emailed unsubscribe. The link carries a TENANT-BOUND `unsub+jwt`
// (packages/auth — its own typ, the token-confusion guard). The GET is a CONFIRMATION page and has NO
// side effects — every mail scanner prefetches links, and a mutating GET would unsubscribe its users;
// the pref flip is the POST, which is also exactly what RFC 8058 one-click (List-Unsubscribe-Post)
// sends. A tampered / expired / wrong-typ / WRONG-TENANT token is a uniform 404 (existence-hiding:
// the response never says which part failed). The flip touches exactly one (tenant, member, pref) —
// the token asserts that intent and nothing else.
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { verifyUnsubToken, type UnsubTokenClaims } from '@wikistead/auth'

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

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
    const kind = claims.action === 'immediate' ? 'mention email' : 'digest email'
    const action = `/email/unsubscribe?token=${encodeURIComponent((req.query as { token?: string }).token!)}`
    return reply.type('text/html').send(`<!doctype html>
<html><head><meta charset="utf-8"><title>Unsubscribe</title></head>
<body style="font-family:sans-serif;max-width:32rem;margin:4rem auto">
<h1 style="font-size:1.2rem">Stop receiving ${esc(kind)}?</h1>
<p>This turns off ${esc(kind)} from this workspace for your account. You can turn it back on any time in your account settings.</p>
<form method="post" action="${esc(action)}"><button type="submit">Unsubscribe</button></form>
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
    return reply.type('text/html').send('<!doctype html><html><body style="font-family:sans-serif;max-width:32rem;margin:4rem auto"><p>Unsubscribed. You can re-enable this email in your account settings.</p></body></html>')
  })
}
