// CE-published extension point for AI assists (#130 / ADR-077).
// EE/Cloud (or a self-host operator) registers a provider (bring-your-own-key: Anthropic/OpenAI/
// a self-hosted endpoint). CE registers NOTHING → AI is OFF by default (zero egress/cost — the
// model runs arms-length at the provider, never bundled). The HOST gathers context FGA-authorized
// first (AI is never an authz side-channel); the provider only completes over what it's handed.
export interface AIProvider {
  readonly name: string
  // Complete a prompt over already-authorized context. Returns the assistant text.
  complete(input: { prompt: string; context?: string }): Promise<{ text: string }>
}

let _provider: AIProvider | null = null

export function registerAIProvider(provider: AIProvider): void {
  _provider = provider
}

// Null when no provider is registered (the default — AI off). Callers MUST handle null
// (and check the `aiFeatures` entitlement) before offering an AI feature.
export function getAIProvider(): AIProvider | null {
  return _provider
}

// Test-only: restore the default (no provider) so registry state can't leak between tests.
export function resetAIProvider(): void {
  _provider = null
}
