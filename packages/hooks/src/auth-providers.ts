// CE-published extension point for authentication.
// EE registers providers here to add SAML, LDAP, SCIM, etc.
// CE's onRequest hook tries registered providers before falling through
// to the built-in API key and OIDC paths.
//
// A provider returns null if it cannot handle the token; the next
// provider (or built-in path) is then tried.
export interface AuthProvider {
  readonly name: string       // 'saml' | 'ldap' | 'scim' | ...
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
