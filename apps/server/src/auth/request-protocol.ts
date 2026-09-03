import type { FastifyRequest } from 'fastify'

// #1091: whether THIS REQUEST arrived over HTTPS — the one fact a cookie's `Secure` attribute (and
// HSTS, `app.ts`'s `onSend` hook) must actually track. `NODE_ENV === 'production'` answers a
// different question (which image is running) and drifted from it: every self-host chart install
// carries `NODE_ENV=production` regardless of `ingress.tls.enabled`, so a deployment the chart itself
// documents as supported (TLS off, plain HTTP) minted session cookies the browser can never send back
// — sign-in returned 200/201 and then never worked. `req.protocol` already honours
// `X-Forwarded-Proto` because `trustProxy: true` is set in `app.ts`; the explicit header read is
// belt-and-suspenders for a proxy that forwards the header without Fastify's own trust-proxy parsing
// picking it up (matches the existing HSTS check this replaces).
export function isHttpsRequest(req: Pick<FastifyRequest, 'headers' | 'protocol'>): boolean {
  const xfp = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0]?.trim()
  return xfp === 'https' || req.protocol === 'https'
}
