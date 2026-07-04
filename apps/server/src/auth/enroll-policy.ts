// #101 / ADR-034 (Addendum, approved comment 712): the "WHO may auto-enrol" trust boundary. The seat
// fortress caps HOW MANY enrol (billableMemberCount + the seats:<tenant> advisory lock); this caps WHO —
// and an IdP claim (email domain, groups) must NEVER be trusted un-verified as an enrolment basis, or a
// second vulnerability opens behind the seat cap (comment 340/406: the two holes the ADR was bounced
// for). This module is the pure decision; the session login path (session.ts) feeds it and then shares
// the ONE seat fortress for every enrol path (open/domain/groups/invite) — a later slice.
//
// The contract encodes the trust boundary in the TYPES so a caller can't slip an un-vetted value in:
//   - `verifiedDomains` MUST be only domains the tenant proved ownership of via DNS TXT (#123 / ADR-065).
//     A bare email-domain allow-list entry is inert until verified — an attacker who sets
//     enrollPolicy=domain + domain=victim.com on their own tenant never gets a verified victim.com, so a
//     victim.com login is not admitted.
//   - `groups` MUST already be normalised through coerceGroups (#102/#111) — the raw claim (array/string/
//     null/huge list, untrusted names) never reaches the intersection.

export type EnrollPolicy = "open" | "domain" | "groups" | "invite_only";

export const ENROLL_POLICIES: readonly EnrollPolicy[] = ["open", "domain", "groups", "invite_only"];

export function isEnrollPolicy(v: unknown): v is EnrollPolicy {
  return typeof v === "string" && (ENROLL_POLICIES as readonly string[]).includes(v);
}

// The domain of an email claim, lower-cased, or null when it isn't a single well-formed address. Defends
// against multi-`@` / empty-domain spoofs — only a clean `local@domain` yields a domain.
export function emailDomain(email: string | undefined | null): string | null {
  if (!email) return null;
  const at = email.indexOf("@");
  if (at < 0 || email.indexOf("@", at + 1) >= 0) return null; // no @, or more than one
  const domain = email.slice(at + 1).trim().toLowerCase();
  return domain && !domain.includes(" ") ? domain : null;
}

export interface EnrollInput {
  policy: EnrollPolicy;
  /** JWT email claim (untrusted). Only used by the `domain` policy, and only against verified domains. */
  email?: string | null;
  /** Groups claim ALREADY normalised via coerceGroups (#102/#111). Never the raw claim. */
  groups: readonly string[];
  /** Domains the tenant PROVED ownership of (DNS TXT, #123/ADR-065). An un-verified domain is absent here. */
  verifiedDomains: readonly string[];
  /** The tenant's group allow-list for the `groups` policy. */
  allowedGroups: readonly string[];
}

// Decide whether a successful OIDC login should AUTO-ENROL this principal (before the seat cap is applied).
// Pure and total: the seat fortress and the actual member/FGA write happen in the caller.
export function enrollEligible(input: EnrollInput): boolean {
  switch (input.policy) {
    case "open":
      return true; // any successful login (homelab) — the seat cap still bounds how many
    case "invite_only":
      return false; // only an invite accept enrols (current behaviour)
    case "domain": {
      const domain = emailDomain(input.email);
      // CRITICAL: match against VERIFIED domains only. `verifiedDomains` excludes un-proven entries, so a
      // spoofed victim.com (not proven by this tenant) is never present → not admitted.
      const verified = new Set(input.verifiedDomains.map((d) => d.trim().toLowerCase()).filter(Boolean));
      return !!domain && verified.has(domain);
    }
    case "groups": {
      // Intersect the ALREADY-normalised claim groups with the allow-list (case-insensitive). The raw
      // claim never reaches here (the caller runs coerceGroups first).
      const allowed = new Set(input.allowedGroups.map((g) => g.trim().toLowerCase()).filter(Boolean));
      return input.groups.some((g) => allowed.has(g.trim().toLowerCase()));
    }
  }
}
