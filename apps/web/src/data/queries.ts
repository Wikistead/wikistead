import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "./apiClient";
import { useSession } from "../session/SessionProvider";

// Shapes mirror the server DTOs (apps/server/src/routes/{spaces,pages}.ts).
// IMPORTANT: GET /spaces and GET /spaces/:id/pages are FGA-filtered server-side
// (a space/page the user can't view is never returned), so the tree cannot leak
// a resource the user lacks access to.
export interface Space {
  id: string;
  name: string;
  // The caller's capability on the space (server-derived from FGA). Drives which
  // management actions the sidebar shows — UI convenience; the server is the gate.
  capability?: "view" | "edit" | "manage";
  // Space branding accent preset key (Phase 5c), or null to inherit. Joined into
  // GET /spaces so the accent cascade applies without a per-space fetch.
  accentKey?: string | null;
}
export interface Page {
  id: string;
  spaceId: string;
  parentId: string | null;
  title: string;
  position: number;
  // Cheap per-page flag (draft != published) for the sidebar badge. Over-
  // approximated server-side (true on any draft save); the open page uses the
  // accurate usePublished() value.
  hasUnpublishedChanges?: boolean;
  // Whether the page has ever been published (cheap: published_at IS NOT NULL).
  // With hasUnpublishedChanges this gives the sidebar's 3-state badge.
  published?: boolean;
}

export function useSpaces(enabled = true) {
  const { token } = useSession();
  return useQuery({
    queryKey: ["spaces"],
    queryFn: () => apiFetch<Space[]>("/spaces", token).then((r) => r ?? []),
    enabled,
  });
}

export function usePages(spaceId: string, enabled = true) {
  const { token } = useSession();
  return useQuery({
    queryKey: ["pages", spaceId],
    queryFn: () => apiFetch<Page[]>(`/spaces/${spaceId}/pages`, token).then((r) => r ?? []),
    enabled,
  });
}

export function useCreateSpace() {
  const { token } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) =>
      apiFetch<Space>("/spaces", token, { method: "POST", body: JSON.stringify({ name }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["spaces"] }),
  });
}

export function useRenameSpace() {
  const { token } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { spaceId: string; name: string }) =>
      apiFetch<Space>(`/spaces/${args.spaceId}`, token, { method: "PATCH", body: JSON.stringify({ name: args.name }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["spaces"] }),
  });
}

export function useCreatePage() {
  const { token } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { spaceId: string; title: string; parentId?: string | null }) =>
      apiFetch<Page>(`/spaces/${args.spaceId}/pages`, token, {
        method: "POST",
        body: JSON.stringify({ title: args.title, parentId: args.parentId ?? null }),
      }),
    onSuccess: (_p, args) => qc.invalidateQueries({ queryKey: ["pages", args.spaceId] }),
  });
}

// Reparent + reorder, and (3b ②) move across spaces. parentId null = top level
// of the destination space; afterId null = first child of the target parent.
// toSpaceId is always sent; the server treats it as a cross-space move only when
// it differs from the page's current space (and the parent's space wins when
// nesting under a page). Both affected space page-lists are invalidated.
export function useMovePage() {
  const { token } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { pageId: string; fromSpaceId: string; toSpaceId: string; parentId: string | null; afterId: string | null }) =>
      apiFetch<Page>(`/pages/${args.pageId}/move`, token, {
        method: "PATCH",
        body: JSON.stringify({ parentId: args.parentId, afterId: args.afterId, spaceId: args.toSpaceId }),
      }),
    onSuccess: (_p, args) => {
      qc.invalidateQueries({ queryKey: ["pages", args.fromSpaceId] });
      if (args.toSpaceId !== args.fromSpaceId) qc.invalidateQueries({ queryKey: ["pages", args.toSpaceId] });
    },
  });
}

export function useRenamePage() {
  const { token } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { pageId: string; spaceId: string; title: string }) =>
      apiFetch<Page>(`/pages/${args.pageId}`, token, {
        method: "PATCH",
        body: JSON.stringify({ title: args.title }),
      }),
    onSuccess: (_p, args) => {
      qc.invalidateQueries({ queryKey: ["pages", args.spaceId] }); // sidebar tree
      qc.invalidateQueries({ queryKey: ["page", args.pageId] });   // toolbar title
    },
  });
}

export function useDeletePage() {
  const { token } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { pageId: string; spaceId: string }) =>
      apiFetch<null>(`/pages/${args.pageId}`, token, { method: "DELETE" }),
    onSuccess: (_p, args) => qc.invalidateQueries({ queryKey: ["pages", args.spaceId] }),
  });
}

export function useDeleteSpace() {
  const { token } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (spaceId: string) =>
      apiFetch<null>(`/spaces/${spaceId}`, token, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["spaces"] }),
  });
}

// ── share links ────────────────────────────────────────────────────────────
export interface ShareLink {
  id: string;
  resource: { type: "page"; id: string };
  capability: "view" | "edit";
  expiresAt: string | null;
  createdAt: string;
}

export function useShareLinks(pageId: string, enabled = true) {
  const { token } = useSession();
  return useQuery({
    queryKey: ["share-links", pageId],
    queryFn: () => apiFetch<ShareLink[]>(`/pages/${pageId}/share-links`, token).then((r) => r ?? []),
    enabled,
  });
}

export function useCreateShareLink() {
  const { token } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { pageId: string; capability: "view" | "edit"; expiresInSeconds: number | null }) =>
      apiFetch<ShareLink>("/share-links", token, {
        method: "POST",
        body: JSON.stringify({
          resource: { type: "page", id: args.pageId },
          capability: args.capability,
          expiresInSeconds: args.expiresInSeconds,
        }),
      }),
    onSuccess: (_l, args) => qc.invalidateQueries({ queryKey: ["share-links", args.pageId] }),
  });
}

export function useRevokeShareLink() {
  const { token } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; pageId: string }) =>
      apiFetch<null>(`/share-links/${args.id}`, token, { method: "DELETE" }),
    onSuccess: (_r, args) => qc.invalidateQueries({ queryKey: ["share-links", args.pageId] }),
  });
}

// ── revisions (page history) ───────────────────────────────────────────────
// GET /pages/:id/revisions is FGA-gated (requires `view`) and plan-gated for
// retention; restore requires `edit`. Both re-checked server-side — the server is
// the fortress; the UI only decides whether to OFFER restore. The backend has
// existed since Phase 0; this is the previously-missing UI wiring.
export interface Revision {
  id: string;
  pageId: string;
  title: string;
  createdBy: string | null;
  createdAt: string;
}

// Published content of a page (draft/publish model). Viewers render this; editors
// see it in view mode while the live draft is what they edit. hasUnpublishedChanges
// is the ACCURATE (decoded) draft-vs-published state for the open page.
export interface Published {
  publishedMd: string | null;
  publishedAt: string | null;
  hasUnpublishedChanges: boolean;
}
export function usePublished(pageId: string) {
  const { token } = useSession();
  return useQuery({
    queryKey: ["published", pageId],
    queryFn: () => apiFetch<Published>(`/pages/${encodeURIComponent(pageId)}/published`, token),
    enabled: pageId.length > 0,
    // The editor is isolated from React (typing never re-renders), so nothing
    // invalidates this on a draft edit. Poll modestly so the "unpublished changes"
    // indicator stays current; a publish invalidates immediately (clears it).
    refetchInterval: 4000,
  });
}

// Publish the current draft as the new published version (edit-gated server-side).
// Invalidates the published content, the revision list (a publish adds one), and
// the page tree (the unpublished badge clears).
export function usePublish(pageId: string) {
  const { token } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<{ publishedAt: string; revisionId: string }>(`/pages/${encodeURIComponent(pageId)}/publish`, token, { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["published", pageId] });
      qc.invalidateQueries({ queryKey: ["revisions", pageId] });
      qc.invalidateQueries({ queryKey: ["pages"] });
    },
  });
}

export function usePageRevisions(pageId: string, enabled = true) {
  const { token } = useSession();
  return useQuery({
    queryKey: ["revisions", pageId],
    queryFn: () => apiFetch<Revision[]>(`/pages/${encodeURIComponent(pageId)}/revisions`, token).then((r) => r ?? []),
    enabled: enabled && pageId.length > 0,
  });
}

// Restore is non-destructive: the server appends a CRDT delta (delete+insert) and
// inserts a fresh revision, then publishes to Valkey so the open editor updates
// live (no reload). We invalidate the list so the new revision appears.
export function useRestoreRevision(pageId: string) {
  const { token } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (revId: string) =>
      apiFetch<null>(`/pages/${encodeURIComponent(pageId)}/revisions/${encodeURIComponent(revId)}/restore`, token, { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["revisions", pageId] }),
  });
}

// ── search ───────────────────────────────────────────────────────────────
// GET /search is two-stage-guarded server-side (Meili candidates -> FGA `view`
// confirm). It returns ONLY authorized hits. The optional snippet is a cropped
// PLAIN-TEXT body excerpt around the match (P2) — and it is part of the hit, so a
// result the FGA stage drops takes its snippet with it. The client never receives
// — and cannot leak — a snippet for a page the user can't view. Render it as text
// (no dangerouslySetInnerHTML): the body is user-authored content.
export interface SearchHit {
  id: string;
  tenantId: string;
  spaceId: string;
  title: string;
  snippet?: string;
}

// GET /pages/:id returns the page plus the caller's capability (view|edit),
// derived server-side from OpenFGA. The editor uses capability ONLY to decide
// whether to offer the Edit control — the collab server is the real fortress, so
// this never widens what a user can actually write.
export interface PageMeta {
  id: string;
  spaceId: string;
  title: string;
  capability: "view" | "edit";
  hasUnpublishedChanges?: boolean;
  canManage?: boolean; // gates the per-page permission UI (server re-checks)
}

// ── per-page access (Phase 4) ──────────────────────────────────────────────
export type PageRelation = "view" | "edit" | "manage";
export interface PageGrant { grantee: string; relation: PageRelation }

export function usePageAccess(pageId: string, enabled = true) {
  const { token } = useSession();
  return useQuery({
    queryKey: ["page-access", pageId],
    queryFn: () => apiFetch<PageGrant[]>(`/pages/${encodeURIComponent(pageId)}/access`, token).then((r) => r ?? []),
    enabled: enabled && pageId.length > 0,
  });
}

export function useGrantAccess(pageId: string) {
  const { token } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { grantee: string; relation: PageRelation }) =>
      apiFetch<null>(`/pages/${encodeURIComponent(pageId)}/access`, token, { method: "POST", body: JSON.stringify(args) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["page-access", pageId] }),
  });
}

export function useRevokeAccess(pageId: string) {
  const { token } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { grantee: string; relation: PageRelation }) =>
      apiFetch<null>(`/pages/${encodeURIComponent(pageId)}/access`, token, { method: "DELETE", body: JSON.stringify(args) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["page-access", pageId] }),
  });
}
export function usePage(pageId: string) {
  const { token } = useSession();
  return useQuery({
    queryKey: ["page", pageId],
    queryFn: () => apiFetch<PageMeta>(`/pages/${encodeURIComponent(pageId)}`, token),
    enabled: pageId.length > 0,
    staleTime: 30_000,
  });
}

// ── per-space access (Phase 5b) — same vocabulary as page access ─────────────
export interface SpaceGrant { grantee: string; capability: PageRelation }
export interface MemberCandidate { sub: string; displayName: string | null }

export function useSpaceAccess(spaceId: string, enabled = true) {
  const { token } = useSession();
  return useQuery({
    queryKey: ["space-access", spaceId],
    queryFn: () => apiFetch<SpaceGrant[]>(`/spaces/${encodeURIComponent(spaceId)}/access`, token).then((r) => r ?? []),
    enabled: enabled && spaceId.length > 0,
  });
}
export function useGrantSpaceAccess(spaceId: string) {
  const { token } = useSession();
  const qc = useQueryClient();
  return useMutation({
    // The API body keys the capability as `relation` (shared page/space vocabulary).
    mutationFn: (args: { grantee: string; capability: PageRelation }) =>
      apiFetch<null>(`/spaces/${encodeURIComponent(spaceId)}/access`, token, { method: "POST", body: JSON.stringify({ grantee: args.grantee, relation: args.capability }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["space-access", spaceId] }),
  });
}
export function useRevokeSpaceAccess(spaceId: string) {
  const { token } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { grantee: string; capability: PageRelation }) =>
      apiFetch<null>(`/spaces/${encodeURIComponent(spaceId)}/access`, token, { method: "DELETE", body: JSON.stringify({ grantee: args.grantee, relation: args.capability }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["space-access", spaceId] }),
  });
}
// Tenant branding (Phase 5d). GET /branding is PUBLIC (resolved from the Host) so
// it works for members, guests, and unauthenticated visitors — it drives the header
// wordmark and the tenant layer of the accent cascade. The server strips branding
// when the plan isn't entitled.
export interface BrandingDTO { displayName: string | null; accentKey: string | null; logoUrl: string | null }
export function useBranding() {
  const { token } = useSession();
  return useQuery({
    queryKey: ["branding"],
    queryFn: () => apiFetch<BrandingDTO>("/branding", token),
    staleTime: 60_000,
  });
}
export function useUpdateTenantBranding() {
  const { token } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { accentKey: string | null; displayName: string | null }) =>
      apiFetch<null>("/tenant/branding", token, { method: "PATCH", body: JSON.stringify(args) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["branding"] }),
  });
}
// Logo: base64 in (no multipart dependency); the server validates magic bytes + size.
export function useUploadTenantLogo() {
  const { token } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (dataBase64: string) =>
      apiFetch<null>("/tenant/branding/logo", token, { method: "POST", body: JSON.stringify({ data: dataBase64 }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["branding"] }),
  });
}
export function useRemoveTenantLogo() {
  const { token } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<null>("/tenant/branding/logo", token, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["branding"] }),
  });
}

// Tenant entitlements (plan feature flags). Used for UI gating (e.g. show an
// upgrade state for branding on Cloud free); the server stays the fortress.
export interface EntitlementsDTO { branding: boolean }
export function useEntitlements() {
  const { token } = useSession();
  return useQuery({
    queryKey: ["entitlements"],
    queryFn: () => apiFetch<EntitlementsDTO>("/entitlements", token),
    staleTime: 60_000,
  });
}

// Set/clear a space's branding accent (Phase 5c). accentKey null = inherit.
export function useUpdateSpaceBranding(spaceId: string) {
  const { token } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (accentKey: string | null) =>
      apiFetch<null>(`/spaces/${encodeURIComponent(spaceId)}/branding`, token, { method: "PATCH", body: JSON.stringify({ accentKey }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["spaces"] }),
  });
}

// API keys (Phase 5f). Per-member ownership; scope ('read'|'write') restricts a key
// below its owner's authority. The tenant policy caps issuable scope.
export type ApiScope = "read" | "write";
export interface ApiKeySummary { id: string; name: string; keyPrefix: string; scope: ApiScope; createdAt: string; lastUsedAt: string | null }
export interface ApiKeyCreated extends ApiKeySummary { plaintext: string }
export function useApiKeys() {
  const { token } = useSession();
  return useQuery({ queryKey: ["api-keys"], queryFn: () => apiFetch<ApiKeySummary[]>("/api-keys", token).then((r) => r ?? []) });
}
export function useCreateApiKey() {
  const { token } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { name: string; scope: ApiScope }) => apiFetch<ApiKeyCreated>("/api-keys", token, { method: "POST", body: JSON.stringify(args) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["api-keys"] }),
  });
}
export function useRevokeApiKey() {
  const { token } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<null>(`/api-keys/${encodeURIComponent(id)}`, token, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["api-keys"] }),
  });
}
export function useApiPolicy() {
  const { token } = useSession();
  return useQuery({ queryKey: ["api-policy"], queryFn: () => apiFetch<{ maxScope: ApiScope }>("/admin/api-policy", token) });
}
export function useUpdateApiPolicy() {
  const { token } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (maxScope: ApiScope) => apiFetch<null>("/admin/api-policy", token, { method: "PATCH", body: JSON.stringify({ maxScope }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["api-policy"] }),
  });
}

// Tenant OIDC (members' SSO) settings (Phase 5e) — tenant#admin only. The secret is
// never returned (write-only); hasSecret signals whether one is stored.
export interface TenantOidcDTO { issuer: string; clientId: string; scopes: string; redirectUri: string; enabled: boolean; hasSecret: boolean }
export interface TenantOidcInput { issuer: string; clientId: string; clientSecret?: string | null; scopes: string; redirectUri: string; enabled: boolean }
export function useTenantOidc() {
  const { token } = useSession();
  return useQuery({
    queryKey: ["tenant-oidc"],
    queryFn: () => apiFetch<TenantOidcDTO | null>("/admin/oidc", token),
    staleTime: 30_000,
  });
}
export function useUpdateTenantOidc() {
  const { token } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: TenantOidcInput) => apiFetch<null>("/admin/oidc", token, { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tenant-oidc"] }),
  });
}
export function useTestTenantOidc() {
  const { token } = useSession();
  return useMutation({
    mutationFn: (issuer: string) => apiFetch<{ ok: boolean; error: string | null }>("/admin/oidc/test", token, { method: "POST", body: JSON.stringify({ issuer }) }),
  });
}

// Pages overview for a space (Phase 5 #5) — space#manage only.
export interface PageOverview { id: string; title: string; published: boolean; hasUnpublishedChanges: boolean; grantCount: number; linkCount: number }
export function useSpacePagesOverview(spaceId: string, enabled = true) {
  const { token } = useSession();
  return useQuery({
    queryKey: ["pages-overview", spaceId],
    queryFn: () => apiFetch<PageOverview[]>(`/spaces/${encodeURIComponent(spaceId)}/pages-overview`, token).then((r) => r ?? []),
    enabled: enabled && spaceId.length > 0,
  });
}

// Tenant-wide spaces overview (Phase 5 #4) — tenant#admin only.
export interface AdminSpace { id: string; name: string; pageCount: number; grantCount: number }
export function useAdminSpaces(enabled = true) {
  const { token } = useSession();
  return useQuery({
    queryKey: ["admin-spaces"],
    queryFn: () => apiFetch<AdminSpace[]>("/admin/spaces", token).then((r) => r ?? []),
    enabled,
  });
}

export function useMemberCandidates(spaceId: string, q: string) {
  const { token } = useSession();
  return useQuery({
    queryKey: ["member-candidates", spaceId, q],
    queryFn: () => apiFetch<MemberCandidate[]>(`/spaces/${encodeURIComponent(spaceId)}/member-candidates?q=${encodeURIComponent(q)}`, token).then((r) => r ?? []),
    enabled: spaceId.length > 0 && q.trim().length > 0,
    staleTime: 10_000,
  });
}

export function useSearch(q: string) {
  const { token } = useSession();
  const query = q.trim();
  return useQuery({
    queryKey: ["search", query],
    queryFn: () => apiFetch<SearchHit[]>(`/search?q=${encodeURIComponent(query)}`, token).then((r) => r ?? []),
    enabled: query.length > 0,
    staleTime: 10_000,
  });
}
