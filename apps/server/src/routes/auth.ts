import type { FastifyInstance } from 'fastify'
import { SESSION_COOKIE, destroySession } from '../auth/session.js'

// Session-backed auth endpoints (P1.1 C2). /auth/login + /auth/callback (the OIDC
// flow that CREATES a session) land in C3; these two only need an existing session
// and so run through the normal auth hook.
export async function authPlugin(app: FastifyInstance) {
  // Who am I — lets the SPA know the current member (or 401 if unauthenticated).
  app.get('/auth/me', async (req) => ({ sub: req.user.sub, groups: req.user.groups }))

  // Logout = real revocation: DELETE the Valkey session (not just the cookie, or a
  // resent sid would still authenticate) AND clear the cookie.
  app.post('/auth/logout', async (req, reply) => {
    const sid = req.cookies?.[SESSION_COOKIE]
    if (sid) await destroySession(app.valkey, sid)
    reply.clearCookie(SESSION_COOKIE, { path: '/' })
    return reply.code(204).send()
  })
}
