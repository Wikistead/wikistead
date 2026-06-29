// A MINIMAL but REAL OpenID Provider for tests (not a mock): it serves discovery,
// JWKS, /authorize and /token, and signs real RS256 id_tokens with jose. The app's
// openid-client runs its genuine flow against it (discovery, PKCE, nonce, code
// exchange, signature/iss/aud validation) — so green here means the real path works,
// not a stubbed one. Only the happy path needs an issuer; the state/membership
// anti-tests don't touch it.
import { createServer, type Server } from 'node:http'
import { createHash } from 'node:crypto'
import { generateKeyPair, exportJWK, SignJWT, type KeyLike } from 'jose'

export interface TestIssuer {
  url: string
  setSubject(sub: string, profile?: { email?: string; name?: string; groups?: unknown }): void
  close(): Promise<void>
}

interface PendingCode {
  nonce: string
  codeChallenge: string | null
  sub: string
  email?: string
  name?: string
  groups?: unknown
}

export async function startTestIssuer(opts: { clientId: string }): Promise<TestIssuer> {
  const { publicKey, privateKey } = await generateKeyPair('RS256')
  const jwk = await exportJWK(publicKey)
  jwk.kid = 'test-key'
  jwk.alg = 'RS256'
  jwk.use = 'sig'

  let subject = { sub: 'test-sub', email: undefined as string | undefined, name: undefined as string | undefined, groups: undefined as unknown }
  const codes = new Map<string, PendingCode>()
  let codeSeq = 0

  const server: Server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://127.0.0.1')
    const issuerUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`

    const json = (obj: unknown) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)) }

    if (u.pathname === '/.well-known/openid-configuration') {
      return json({
        issuer: issuerUrl,
        authorization_endpoint: `${issuerUrl}/authorize`,
        token_endpoint: `${issuerUrl}/token`,
        jwks_uri: `${issuerUrl}/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'],
        grant_types_supported: ['authorization_code'],
      })
    }

    if (u.pathname === '/jwks') return json({ keys: [jwk] })

    // Authorization endpoint — the "IdP login" step. Bind the request's nonce +
    // PKCE challenge + the configured subject to a fresh code, then redirect back.
    if (u.pathname === '/authorize') {
      const code = `code-${++codeSeq}`
      codes.set(code, {
        nonce: u.searchParams.get('nonce') ?? '',
        codeChallenge: u.searchParams.get('code_challenge'),
        sub: subject.sub,
        email: subject.email,
        name: subject.name,
        groups: subject.groups,
      })
      const redirectUri = u.searchParams.get('redirect_uri')!
      const state = u.searchParams.get('state') ?? ''
      const loc = `${redirectUri}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`
      res.writeHead(302, { location: loc })
      return res.end()
    }

    // Token endpoint — verify PKCE, then mint a real signed id_token.
    if (u.pathname === '/token' && req.method === 'POST') {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        void (async () => {
          const p = new URLSearchParams(body)
          const pending = codes.get(p.get('code') ?? '')
          codes.delete(p.get('code') ?? '')
          if (!pending) { res.writeHead(400, { 'content-type': 'application/json' }); return res.end('{"error":"invalid_grant"}') }
          // PKCE S256 check (real issuer behavior).
          const verifier = p.get('code_verifier') ?? ''
          const challenge = createHash('sha256').update(verifier).digest('base64url')
          if (pending.codeChallenge && pending.codeChallenge !== challenge) {
            res.writeHead(400, { 'content-type': 'application/json' }); return res.end('{"error":"invalid_grant"}')
          }
          const idToken = await new SignJWT({ nonce: pending.nonce, email: pending.email, name: pending.name, ...(pending.groups !== undefined ? { groups: pending.groups } : {}) })
            .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
            .setIssuedAt()
            .setIssuer(issuerUrl)
            .setAudience(opts.clientId)
            .setSubject(pending.sub)
            .setExpirationTime('5m')
            .sign(privateKey as KeyLike)
          json({ access_token: 'test-access', id_token: idToken, token_type: 'Bearer', expires_in: 300 })
        })()
      })
      return
    }

    res.writeHead(404); res.end()
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  return {
    url,
    setSubject(sub, profile) { subject = { sub, email: profile?.email, name: profile?.name, groups: profile?.groups } },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}
