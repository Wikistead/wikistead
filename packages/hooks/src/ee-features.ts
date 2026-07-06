// CE-published seam for MOUNTING Enterprise features (#178 / ADR-084). The EE composition root — a
// SEPARATE entrypoint that is allowed to import `@wikistead-ee/*` (the CE app entrypoint is not,
// enforced by scripts/check-ce-imports.mjs) — registers a mount function; the CE core invokes it
// after building the host. A CE / self-host build registers NOTHING → no EE features run (open-core).
//
// The host type is INTENTIONALLY left generic here. The concrete contract (which CE handles the EE
// features receive — tenant DB, FGA client, auth helpers, …) is fixed WITH the first feature move
// (SCIM), not frozen speculatively: ADR-084's review concluded the seam and the first move are
// inseparable, so freezing an EeHost shape before a real consumer risks rework. This module provides
// only the register/get mechanism; the composition root supplies a typed host, the EE mount consumes
// it. Mirrors the other @wikistead/hooks seams (auth provider, search driver, AI provider).
export type EeMount<Host = unknown> = (host: Host) => Promise<void> | void

let _mount: EeMount | null = null

// Generic over the host so the EE composition root can register a mount typed to the CONCRETE host
// (e.g. the Fastify app) while the seam stores it host-agnostically. getEeFeatures() then invokes it
// with the actual host (`getEeFeatures()?.(app)`), which is assignable to the stored `unknown` host.
export function registerEeFeatures<Host = unknown>(mount: EeMount<Host>): void {
  _mount = mount as EeMount
}

// Null when no EE composition root has registered (the default — CE/self-host). The CE core calls
// `getEeFeatures()?.(host)` so an absent registration is simply a no-op.
export function getEeFeatures(): EeMount | null {
  return _mount
}

// Test-only: restore the default (no EE) so registry state can't leak between tests.
export function resetEeFeatures(): void {
  _mount = null
}
