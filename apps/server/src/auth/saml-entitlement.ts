// #693 (ruling): whether SAML SSO is ENTITLED is answered by a registered predicate, not by a
// CE read of the EE lever. Same seam shape as the audit sink (audit/sink.ts, #688): the EE
// composition root registers a predicate that reads the entitlement; a CE build registers nothing
// and the answer is ALWAYS false.
//
// Why a seam and not resolveEntitlements(plan).samlSso in place: the direct read was the exact
// defect the #693 lint exists to catch (an EE lever's enforcement in CE bytes), and it carried a
// live failure mode — a CE build resolves entitlements to UNLIMITED (samlSso: true), so imported
// data with an enabled `tenant_saml` row made the resolver count a door with NO BYTES behind it as
// an effective own IdP, which reaches the platform-login lapse arithmetic (own-IdP misdetection can
// suppress platform login). With the CE default pinned to false, that path is gone structurally.
//
// The CE resolver KEEPS the saml vocabulary (lockout guard, lapse rule, stance arithmetic — ADR-195
// "one place answers the effective doors"; #568 "a door outside the resolver is a second door the
// lockout guard cannot see"). What moved to ee/ is only the entitlement READ.

export type SamlEntitlementPredicate = (tenant: { plan: string }) => boolean

let predicate: SamlEntitlementPredicate | null = null

// Called by the EE composition root (packages/ee-server) — and by the dev suite's setup, which
// keeps the EE composition's behaviour. Last registration wins so a test can re-register.
export function registerSamlEntitlement(p: SamlEntitlementPredicate): void {
  predicate = p
}

/** Test escape: back to the CE default (no predicate → false). Module state is per-vitest-file. */
export function resetSamlEntitlement(): void {
  predicate = null
}

/** Whether this tenant is entitled to SAML SSO. A build with no EE composition answers false. */
export function samlEntitled(tenant: { plan: string }): boolean {
  return predicate ? predicate(tenant) : false
}
