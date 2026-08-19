// CE-published extension point for authentication: a composition that adds its own way of vouching
// for a caller registers it here, and CE's onRequest hook tries the registered providers before
// falling through to the built-in API key and OIDC paths.
//
// NOTHING REGISTERS HERE TODAY (#775). It is an extension point kept for a mechanism that wants it;
// the only callers are two test dummies. The EE build's SAML arrives through registerEeFeatures, not
// this seam. Said plainly because this file publishes: the previous wording named SAML, LDAP and
// SCIM in the present tense, which reads to someone weighing the paid build as "it has LDAP" — and
// LDAP is not implemented anywhere in this repository.
//
// A provider returns null if it cannot handle the token; the next
// provider (or built-in path) is then tried.
export interface AuthProvider {
  readonly name: string       // whatever the mechanism is called — nothing ships under this seam yet
  verify(
    token: string,
    tenantId: string,
  ): Promise<{ sub: string; groups: string[] } | null>
}

const _providers: AuthProvider[] = []

export function registerAuthProvider(provider: AuthProvider): void {
  _providers.push(provider)
}

export function getAuthProviders(): ReadonlyArray<AuthProvider> {
  return _providers
}

// Test seam (the resetAIProvider precedent): a suite that registers a provider must be able to take
// it back out, or it leaks into every later suite in the same process.
export function resetAuthProviders(): void {
  _providers.length = 0
}
