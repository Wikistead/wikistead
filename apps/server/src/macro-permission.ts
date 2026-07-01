import { resolveEntitlements } from '@wikistead/entitlements'

// Host-mediated macro permission gate (#93 / ADR-073). The single place that decides whether a
// macro of a given trust tier may run for a tenant — macros NEVER self-authorize (the host asks
// this; a macro can't claim "I'm allowed"). Layered with #075 sandbox (this = "may it run", the
// sandbox = "how it runs"). (A tenant macro level-cap lever was withdrawn — #93; not persisted here.)
//
//   first-party  → always allowed (platform-signed, ADR-076).
//   user / third-party → require BOTH userMacros entitlement (plan includes user macros) AND the
//     tenant-admin allowlist (the admin opted this macro in). Either false ⇒ denied.
// CE/self-host resolves UNLIMITED (userMacros: true) → Community First; the admin allowlist still
// applies as the deliberate opt-in. entitlement⟂authz: this reads the resolver, not OpenFGA.

export type MacroTrust = 'first-party' | 'user' | 'third-party'

export function canRunMacro(plan: string, trust: MacroTrust, adminAllowed: boolean): boolean {
  if (trust === 'first-party') return true
  return resolveEntitlements(plan).userMacros && adminAllowed
}
