// #904: the e2e identity must let a spec tell "the screen shows the display name" from "the screen
// shows the subject". While the issuer's `name` claim WAS the subject those two produce the same
// string, and every assertion about either one passes with the name resolution deleted: with no
// display name the surfaces fall back to `shortPrincipalId(sub)`, and shortening "dev-user" returns
// "dev-user".
//
// TWO checks, because the rule and its wiring break separately. The first runs the derivation; the
// second proves the issuer actually signs the derived value into the token rather than the subject —
// a green derivation nobody calls would leave the hole exactly as it was.
import { describe, it, expect } from 'vitest'
import { displayNameFor, startE2eIssuer } from '../../../../tests/e2e/oidc-issuer'

// The payload half of a JWS, decoded here rather than through a library. `jose` is the e2e package's
// dependency, not this one's, and adding it would be a dependency change for a claim that is three
// lines of base64url — and reading the token with something OTHER than what signed it is the better
// check anyway.
function claimsOf(jwt: string): Record<string, unknown> {
  const payload = jwt.split('.')[1]
  if (!payload) throw new Error('not a JWS: no payload segment')
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>
}

// Seeded and generated subjects alike: the generated ones matter because `e2e_sub` lets a spec sign
// in as anybody, and a name that collapses for THOSE re-opens the hole for the personas.
const SUBJECTS = ['dev-user', 'acme-admin', 'acme-user', 'avatar372-b1-1785205206276', 'inv-abc']

describe('#904: the e2e identity is distinguishable from its subject', () => {
  it('the derived name never equals the subject it came from', () => {
    for (const sub of SUBJECTS) {
      expect(displayNameFor(sub), `${sub} must not name itself`).not.toBe(sub)
      expect(displayNameFor(sub).length).toBeGreaterThan(0)
    }
    // The seeded row's name in `infra/db/seed.ts`, so the seed and the login upsert agree instead of
    // overwriting each other with different answers.
    expect(displayNameFor('dev-user')).toBe('Dev User')
    expect(displayNameFor('acme-admin')).toBe('Acme Admin')
  })

  it('the issuer signs the derived name into the token, not the subject', async () => {
    const issuer = await startE2eIssuer({ clientId: 'e2e-client' })
    try {
      const authorize = await fetch(
        `${issuer.url}/authorize?redirect_uri=http%3A%2F%2F127.0.0.1%2Fcb&state=s&nonce=n`,
        { redirect: 'manual' },
      )
      const code = new URL(authorize.headers.get('location')!, 'http://127.0.0.1').searchParams.get('code')
      expect(code, 'the issuer must hand back a code').toBeTruthy()
      const token = await fetch(`${issuer.url}/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ code: code!, code_verifier: '' }).toString(),
      })
      const { id_token } = (await token.json()) as { id_token: string }
      const claims = claimsOf(id_token)
      // The claim the login upsert stores as `members.display_name` (session.ts).
      expect(claims.name, 'the id token carries a name').toBeTruthy()
      expect(claims.name, 'the name is not the subject').not.toBe(claims.sub)
      expect(claims.name).toBe(displayNameFor(String(claims.sub)))
    } finally {
      await issuer.close()
    }
  })
})
