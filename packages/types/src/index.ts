// Shared domain types. Source of truth for cross-service contracts.

/** A capability a principal may hold on a resource (see ADR: ReBAC/OpenFGA). */
export type Capability = "view" | "comment" | "edit" | "manage";

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
