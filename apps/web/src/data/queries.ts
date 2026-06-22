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
}

export function useSpaces() {
  const { token } = useSession();
  return useQuery({
    queryKey: ["spaces"],
    queryFn: () => apiFetch<Space[]>("/spaces", token).then((r) => r ?? []),
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
    onSuccess: (_p, args) => qc.invalidateQueries({ queryKey: ["pages", args.spaceId] }),
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
