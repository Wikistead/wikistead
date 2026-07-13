// Shared domain types. Source of truth for cross-service contracts.

/** A capability a principal may hold on a resource (see ADR: ReBAC/OpenFGA). */
export type Capability = "view" | "comment" | "edit" | "manage";

/**
 * Branding accent presets (Phase 5c/5d). Branding stores a KEY, not a raw colour,
 * so the palette (per-theme hex + contrast fg, defined in the web app) can be tuned
 * without migrating data. The server validates writes against this allowlist; null
 * clears (inherit). Personal light/dark (bg/fg) is orthogonal and unaffected.
 */
export const ACCENT_PRESETS = [
  "blue", "indigo", "violet", "green", "teal", "amber", "rose", "slate",
] as const;
export type AccentKey = (typeof ACCENT_PRESETS)[number];
export function isAccentKey(v: unknown): v is AccentKey {
  return typeof v === "string" && (ACCENT_PRESETS as readonly string[]).includes(v);
}

/** Tenant isolation strategy — the app never branches on this; resolvers do. */
export type TenantIsolation = "logical" | "namespace";

export interface Tenant {
  id: string;
  slug: string; // subdomain
  customDomain?: string;
  isolation: TenantIsolation;
  plan: string;
}

export interface Space {
  id: string;
  tenantId: string;
  name: string;
}

export interface Page {
  id: string;
  tenantId: string;
  spaceId: string;
  parentId: string | null;
  title: string;
}

/** Principal resolved from a verified token (member or guest). */
export type Principal =
  | { kind: "member"; tenantId: string; userId: string; groups: string[] }
  | { kind: "guest"; tenantId: string; shareLinkId: string; resource: ResourceRef; capability: Capability };

export interface ResourceRef {
  type: "page" | "space";
  id: string;
}

/** Claims carried by an app-signed guest share token. */
export interface GuestTokenClaims {
  tenantId: string;
  shareLinkId: string;
  resource: ResourceRef;
  capability: Capability;
  // #331 / ADR-138 (C-6): a pseudonymous per-session identity for an anonymous editor — `anon:<12 hex>`,
  // HMAC(GUEST_TOKEN_SECRET, CSPRNG nonce). Display/attribution metadata ONLY (the FGA principal stays
  // `share_link:<id>` — no capability change). Not derived from any PII / raw IP (GDPR). One session = one
  // pseudonym. Optional so an older token without it still verifies.
  anonId?: string;
  iat: number;
  exp: number;
}

/** Yjs document name = stable, tenant-namespaced room id. Never cross tenants. */
export function docName(tenantId: string, pageId: string): string {
  return `t:${tenantId}:p:${pageId}`;
}

/** Denormalized ACL projected onto each search document (see ADR: Meilisearch). */
export interface SearchDoc {
  id: string;
  tenantId: string;
  spaceId: string;
  title: string;
  body: string;
  viewerUsers: string[];
  viewerGroups: string[];
  isPublic: boolean;
  updatedAt: number;
}
