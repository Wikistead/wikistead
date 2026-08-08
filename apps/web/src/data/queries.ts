import { useEffect, useState } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import { apiFetch, assetUrl } from "./apiClient";
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
  // #326: whether the caller may MODERATE this space. Reported separately from `capability` because a
  // moderator is not a manager — folding it in would hand every moderator rename and delete.
  canModerate?: boolean;
  // #607 / ADR-209: whether the caller runs this space's ROSTER (space#access_manager). Alongside the
  // ladder like canModerate — never widening it (#326's precedent).
  canManageAccess?: boolean;
  // Space branding accent preset key (Phase 5c), or null to inherit. Joined into
  // GET /spaces so the accent cascade applies without a per-space fetch.
  accentKey?: string | null;
  // Uploaded space icon image, absolute URL ready for an <img> src, or null → the
  // sidebar renders a deterministic initials chip. The server returns a relative API
  // path; useSpaces prefixes it with the API base. (The text-glyph override was removed.)
  iconImageUrl?: string | null;
  // #364 / ADR-157: the space HOME page pointer. Server-side oracle guard: null when unset OR when
  // the caller cannot view the pointed page (byte-identical), so the client can trust it blindly.
  homePageId?: string | null;
  // #437 / ADR-167: the RESOLVED deletion-pathway policy (space override ?? tenant default).
  // Shapes the delete menu only — the routes gate regardless.
  deleteMode?: "trash_only" | "both" | "direct_only";
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
  // #109 Fix B: page is private (allowlist-only). Drives the lock badge in the sidebar
  // and next to the title. Exposed only to viewers of the page (non-viewers 404), so it
  // leaks nothing. `restrict`-only (deny) pages are NOT private and show no lock.
  private?: boolean;
  // #329 rework: freeze level on the tree list too, so the sidebar can pair a snowflake with the
  // lock (same exposure rule as `private` — viewers only, reveals nothing).
  frozen?: "full" | "guests" | null;
  // #290 / ADR-114: the page's :::todo checkbox aggregate (published). taskTotal > 0 ⟺ the page has a
  // :::todo with tasks → the sidebar shows a progress ring. Display-only.
  taskDone?: number;
  taskTotal?: number;
  // #222: title-bar metadata row. createdAt/updatedAt are timestamps; createdBy is the creator's sub,
  // updatedBy the last-publisher's sub (option A). Present only on the single-page GET (getPage), not the
  // tree list. Resolved to name/avatar via AuthorChip; null when unrecorded (pre-migration pages).
  createdAt?: string;
  updatedAt?: string;
  createdBy?: string | null;
  updatedBy?: string | null;
  // #486 / ADR-150 Addendum 2: the author display name/avatar resolved server-side on this view-gated
  // response (override ?? OIDC name; null = un-customized/cross-tenant/guest author). When present the
  // AuthorChip uses it directly instead of the customized-only /members/identities lookup — so a member
  // who never set an override still shows their IdP name here (the gated surface may reveal it).
  createdByName?: string | null;
  createdByHasAvatar?: boolean;
  updatedByName?: string | null;
  updatedByHasAvatar?: boolean;
}

export function useSpaces(enabled = true) {
  const { token } = useSession();
  return useQuery({
    queryKey: ["spaces"],
    // #623 slice 12b: the route pages now, so this walks it and hands its callers the same complete
    // array they had before. The sidebar switcher and the API-key space picker both filter on the
    // client and both say how many are hidden — paging THEM would turn "filter" into "filter this
    // page" and make the hidden count a lie, which is acceptance 1 and 2 and needs its own slice.
    //
    // What this does fix is the payload: a tenant with 253 spaces no longer receives all of them in one
    // response. The walk keeps going while `nextCursor` is non-null, INCLUDING over pages that came
    // back empty — the server filters by authorization after the SQL, so an empty page does not mean
    // the end (see `listSpaces`). Stopping early would silently shorten somebody's space list.
    queryFn: async () => {
      const out: Space[] = [];
      let cursor: string | null = null;
      do {
        const page: { spaces: Space[]; nextCursor: string | null } | null = await apiFetch(
          `/spaces${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`, token,
        );
        out.push(...(page?.spaces ?? []));
        cursor = page?.nextCursor ?? null;
      } while (cursor);
      return out.map((s) => ({ ...s, iconImageUrl: s.iconImageUrl ? assetUrl(s.iconImageUrl) : null }));
    },
    enabled,
  });
}

export function usePages(spaceId: string, enabled = true) {
  const { token } = useSession();
  return useQuery({
    queryKey: ["pages", spaceId],
    queryFn: () => apiFetch<{ pages: Page[]; truncated: boolean }>(`/spaces/${spaceId}/pages`, token).then((r) => r?.pages ?? []),
    enabled,
  });
}

// #445 the caller's own capabilities. Read to HIDE an affordance the server would refuse;
// never to decide access (the server is the fortress, and the 403 path still reports the reason).
export interface MyCapabilities { canCreateSpaces: boolean }
export function useMyCapabilities() {
  const { token } = useSession();
  return useQuery({
    queryKey: ["me-capabilities"],
    queryFn: () => apiFetch<MyCapabilities>("/me/capabilities", token),
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
    mutationFn: (args: { spaceId: string; title?: string; parentId?: string | null; fromPageId?: string | null; templateId?: string | null }) =>
      apiFetch<Page>(`/spaces/${args.spaceId}/pages`, token, {
        method: "POST",
        // #250: templateId seeds the draft from a template snapshot (title defaults to the template name
        // server-side when omitted). fromPageId (#229 "duplicate") stays supported and mutually exclusive.
        body: JSON.stringify({ title: args.title, parentId: args.parentId ?? null, fromPageId: args.fromPageId ?? null, templateId: args.templateId ?? null }),
      }),
    // #534: do NOT return the invalidation's promise. react-query awaits whatever a mutation's onSuccess
    // returns before it calls the CALLER's onSuccess — and the caller's is where the sidebar navigates to
    // the new page. Returning it meant every new page waited for the whole space tree to refetch AND
    // render before the URL changed. Measured on 200 pages: 1.6s to navigate, ~2.0s to editable, with no
    // API call over 400ms; on a small tree the same click was 183ms/471ms. `void` lets the refetch land a
    // moment later, which is exactly when a new row in the tree is wanted.
    onSuccess: (_p, args) => { void qc.invalidateQueries({ queryKey: ["pages", args.spaceId] }); },
  });
}

// #248 / ADR-110: save a template (snapshot) from a page. scope decides the audience
// (personal / space / tenant). The server view-gates the source + writes the FGA tuples.
export type TemplateScope = "personal" | "space" | "tenant";
export function useSaveTemplate() {
  const { token } = useSession();
  return useMutation({
    mutationFn: (args: { fromPageId: string; name: string; scope: TemplateScope; spaceId?: string | null }) =>
      apiFetch<{ id: string }>(`/templates`, token, {
        method: "POST",
        body: JSON.stringify({ fromPageId: args.fromPageId, name: args.name, scope: args.scope, spaceId: args.spaceId ?? null }),
      }),
  });
}

// #249 / ADR-110: the /templates management surface. The server FGA-filters the list by `view`, so the
// client shows exactly what it is told (no client-side scope filtering). Rename/delete are manage-gated
// server-side (the UI only hides the actions as the first layer).
export interface TemplateSummary { id: string; name: string; scope: TemplateScope; spaceId: string | null; createdBy: string; createdAt: string; canManage: boolean }
export function useTemplates(enabled = true) {
  const { token } = useSession();
  return useQuery({
    queryKey: ["templates"],
    queryFn: () => apiFetch<TemplateSummary[]>(`/templates`, token).then((r) => r ?? []),
    enabled,
  });
}
export function useTemplateBody(id: string | null) {
  const { token } = useSession();
  return useQuery({
    queryKey: ["template", id],
    queryFn: () => apiFetch<{ id: string; name: string; scope: TemplateScope; body: string }>(`/templates/${encodeURIComponent(id!)}`, token),
    enabled: id != null,
  });
}
export function useRenameTemplate() {
  const { token } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; name: string }) =>
      apiFetch<void>(`/templates/${encodeURIComponent(args.id)}`, token, { method: "PATCH", body: JSON.stringify({ name: args.name }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["templates"] }),
  });
}
export function useDeleteTemplate() {
  const { token } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(`/templates/${encodeURIComponent(id)}`, token, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["templates"] }),
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

// #411 / ADR-153: DELETE now moves to the trash (restorable for 30 days); purge is the permanent path.
export function useDeletePage() {
  const { token } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { pageId: string; spaceId: string }) =>
      apiFetch<null>(`/pages/${args.pageId}`, token, { method: "DELETE" }),
    onSuccess: (_p, args) => {
      qc.invalidateQueries({ queryKey: ["pages", args.spaceId] });
      qc.invalidateQueries({ queryKey: ["backlinks"] }); // #307 / ADR-127: a deleted page's outbound links vanish → other pages' backlinks change
      qc.invalidateQueries({ queryKey: ["space-trash", args.spaceId] });
    },
  });
}

// #511 / ADR-185: bulk-delete a selection of pages in a space. The server re-checks per-page authz and
// returns a partial-success map ({ok, skipped} + per-item result) — never all-or-nothing — so a caller
// who may delete some but not all sees exactly what happened. Invalidates the same views a single delete does.
export interface BulkDeleteResult { results: { id: string; ok: boolean; reason?: string }[]; deleted: number; skipped: number }
export function useBulkDeletePages() {
  const { token } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { spaceId: string; pageIds: string[] }) =>
      apiFetch<BulkDeleteResult>(`/spaces/${encodeURIComponent(args.spaceId)}/pages/bulk-delete`, token, {
        method: "POST",
        body: JSON.stringify({ pageIds: args.pageIds }),
      }),
    onSuccess: (_r, args) => {
      qc.invalidateQueries({ queryKey: ["pages-overview", args.spaceId] });
      qc.invalidateQueries({ queryKey: ["pages", args.spaceId] });
      qc.invalidateQueries({ queryKey: ["backlinks"] });
      qc.invalidateQueries({ queryKey: ["space-trash", args.spaceId] });
    },
  });
}

// #511 / ADR-185 (slice 2): bulk-publish a selection of pages in a space. The server re-checks the per-page
// `publish` gate and returns the same partial-success map ({ok, skipped} + per-item result), so a caller who
// may publish some but not all sees exactly what happened. Non-destructive (no trash), so no confirm posture.
export interface BulkPublishResult { results: { id: string; ok: boolean; reason?: string }[]; published: number; skipped: number }
export function useBulkPublishPages() {
  const { token } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { spaceId: string; pageIds: string[] }) =>
      apiFetch<BulkPublishResult>(`/spaces/${encodeURIComponent(args.spaceId)}/pages/bulk-publish`, token, {
        method: "POST",
        body: JSON.stringify({ pageIds: args.pageIds }),
      }),
    onSuccess: (_r, args) => {
      qc.invalidateQueries({ queryKey: ["pages-overview", args.spaceId] });
      qc.invalidateQueries({ queryKey: ["pages", args.spaceId] });
      qc.invalidateQueries({ queryKey: ["backlinks"] });
    },
  });
}

// #511 / ADR-185 (slice 5): bulk MOVE into another space. The destination must be one the caller MANAGES —
// the picker only offers those, and the server checks it again (the approved decision is manage on BOTH
// sides, and the single-page primitive only asks `edit` of the destination, so the bulk path adds it).
// `movedWithAncestor`: the page travelled inside a selected parent's subtree, so it is at the destination
// but was never a move of its own — reporting it as one would overstate what happened.
export interface BulkMoveResult { results: { id: string; ok: boolean; reason?: string; movedWithAncestor?: boolean }[]; moved: number; skipped: number }
export function useBulkMovePages() {
  const { token } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { spaceId: string; targetSpaceId: string; pageIds: string[] }) =>
      apiFetch<BulkMoveResult>(`/spaces/${encodeURIComponent(args.spaceId)}/pages/bulk-move`, token, {
        method: "POST",
        body: JSON.stringify({ pageIds: args.pageIds, targetSpaceId: args.targetSpaceId }),
      }),
    onSuccess: (_r, args) => {
      // Both ends change: the pages leave one tree and arrive in another.
      for (const id of [args.spaceId, args.targetSpaceId]) {
        qc.invalidateQueries({ queryKey: ["pages-overview", id] });
        qc.invalidateQueries({ queryKey: ["pages", id] });
      }
    },
  });
}

// #511 / ADR-185 (slice 3): bulk VISIBILITY for a selection. The server re-checks the per-page `share`
// gate, writes the private marker pair, cascades to descendants and reindexes each affected page, and
// returns the same partial-success map. NOT reversible by the caller in the direction that matters: private
// is subtracted from the space-inherited chain, so privatising a page you do not own personally takes your
// own `share` on it away (measured) — the UI confirms that direction before running it.
// #511 `unchanged` (already in the requested state) is reported apart from `skipped` (the caller's
// per-page gate said no) — conflating them told people they lacked permission when they simply re-ran it.
export interface BulkVisibilityResult { results: { id: string; ok: boolean; noop?: boolean; reason?: string }[]; changed: number; unchanged: number; skipped: number }
export function useBulkSetPageVisibility() {
  const { token } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { spaceId: string; pageIds: string[]; makePrivate: boolean }) =>
      apiFetch<BulkVisibilityResult>(`/spaces/${encodeURIComponent(args.spaceId)}/pages/bulk-visibility`, token, {
        method: "POST",
        body: JSON.stringify({ pageIds: args.pageIds, private: args.makePrivate }),
      }),
    onSuccess: (_r, args) => {
      qc.invalidateQueries({ queryKey: ["pages-overview", args.spaceId] });
      qc.invalidateQueries({ queryKey: ["pages", args.spaceId] });
    },
  });
}

// #437 / ADR-167: the DIRECT permanent path (modes 'both' / 'direct_only'; the server 400s otherwise).
export function useDirectDeletePage() {
  const { token } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { pageId: string; spaceId: string }) =>
      apiFetch<null>(`/pages/${args.pageId}/permanent`, token, { method: "DELETE" }),
    onSuccess: (_p, args) => {
      qc.invalidateQueries({ queryKey: ["pages", args.spaceId] });
      qc.invalidateQueries({ queryKey: ["backlinks"] });
      qc.invalidateQueries({ queryKey: ["space-trash", args.spaceId] });
    },
  });
}

// #437 / ADR-167: the delete-mode knobs (tenant admin + per-space override).
export function useAdminDeleteMode(enabled = true) {
  const { token } = useSession();
  return useQuery({
    queryKey: ["admin-delete-mode"],
    queryFn: () => apiFetch<{ deleteMode: string }>(`/admin/delete-mode`, token),
    enabled,
  });
}
export function useSetAdminDeleteMode() {
  const { token } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: string) => apiFetch<{ deleteMode: string }>(`/admin/delete-mode`, token, { method: "PUT", body: JSON.stringify({ deleteMode: v }) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin-delete-mode"] });
      qc.invalidateQueries({ queryKey: ["spaces"] }); // the resolved mode rides the spaces listing
    },
  });
}
export function useSpaceDeleteMode(spaceId: string, enabled = true) {
  const { token } = useSession();
  return useQuery({
    queryKey: ["space-delete-mode", spaceId],
    queryFn: () => apiFetch<{ deleteMode: string | null; tenantDefault: string; resolved: string }>(`/spaces/${encodeURIComponent(spaceId)}/delete-mode`, token),
    enabled: enabled && spaceId.length > 0,
  });
}
export function useSetSpaceDeleteMode() {
  const { token } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { spaceId: string; deleteMode: string | null }) =>
      apiFetch<{ deleteMode: string | null }>(`/spaces/${encodeURIComponent(args.spaceId)}/delete-mode`, token, { method: "PUT", body: JSON.stringify({ deleteMode: args.deleteMode }) }),
    onSuccess: (_r, args) => {
      qc.invalidateQueries({ queryKey: ["space-delete-mode", args.spaceId] });
      qc.invalidateQueries({ queryKey: ["spaces"] });
    },
  });
}

// #411 / ADR-153: the space trash (roots only; entries the caller can manage).
export interface TrashEntry { id: string; title: string; deletedAt: string; deletedBy: string | null; descendants: number }

export function useSpaceTrash(spaceId: string, enabled = true) {
  const { token } = useSession();
  return useQuery({
    queryKey: ["space-trash", spaceId],
    queryFn: () => apiFetch<TrashEntry[]>(`/spaces/${encodeURIComponent(spaceId)}/trash`, token).then((r) => r ?? []),
    enabled: enabled && spaceId.length > 0,
  });
}

export function useRestorePage() {
  const { token } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { pageId: string; spaceId: string }) =>
      apiFetch<{ reparented: boolean }>(`/pages/${args.pageId}/restore`, token, { method: "POST" }),
    onSuccess: (_r, args) => {
      qc.invalidateQueries({ queryKey: ["space-trash", args.spaceId] });
      qc.invalidateQueries({ queryKey: ["pages", args.spaceId] }); // the subtree reappears in the tree
      qc.invalidateQueries({ queryKey: ["backlinks"] });
    },
  });
}

export function usePurgePage() {
  const { token } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { pageId: string; spaceId: string }) =>
      apiFetch<null>(`/pages/${args.pageId}/purge`, token, { method: "DELETE" }),
    onSuccess: (_r, args) => {
      qc.invalidateQueries({ queryKey: ["space-trash", args.spaceId] });
    },
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
export type ShareResource = { type: "page" | "space"; id: string };
export interface ShareLink {
  id: string;
  resource: ShareResource;
  capability: "view" | "comment" | "edit";
  expiresAt: string | null;
  createdAt: string;
}
const linksPath = (r: ShareResource) => `/${r.type}s/${r.id}/share-links`; // /pages/.. | /spaces/..
const linksKey = (r: ShareResource) => ["share-links", r.type, r.id];

// #230: pages that reference this page (server FGA-view-gates each result).
export interface Backlink { id: string; title: string }
export function useBacklinks(pageId: string | null, enabled = true) {
  const { token } = useSession();
  return useQuery({
    queryKey: ["backlinks", pageId],
    queryFn: () => apiFetch<Backlink[]>(`/pages/${encodeURIComponent(pageId!)}/backlinks`, token).then((r) => r ?? []),
    enabled: enabled && pageId != null,
  });
}

// #322 / ADR-133: 2-hop RELATED pages — OTHER pages that also link to a page this one links to, grouped by
// the shared link. Member-only + server view-filters BOTH endpoints of every edge (no unviewable page/title
// leaks). Lazy: only fetched when the Related section opens (the panel passes enabled).
export interface RelatedGroup { intermediate: { id: string; title: string }; pages: { id: string; title: string }[] }
export interface RelatedResult { groups: RelatedGroup[]; truncated: boolean }
export function useRelated(pageId: string | null, enabled = true) {
  const { token } = useSession();
  return useQuery({
    queryKey: ["related", pageId],
    queryFn: () => apiFetch<RelatedResult>(`/pages/${encodeURIComponent(pageId!)}/related`, token).then((r) => r ?? { groups: [], truncated: false }),
    enabled: enabled && pageId != null,
  });
}

// #413 / ADR-145 §5: viewer-scoped tag suggestions (frontmatter chip editor + the :::tagged picker).
// Member-only; the server offers a tag only when the viewer can see ≥1 page carrying it (a tag name is
// content — the autocomplete must not reveal what invisible pages are about).
export interface TagSuggestion { tag: string; display: string }
export function useTagSuggestions(q: string, enabled = true) {
  const { token } = useSession();
  return useQuery({
    queryKey: ["tag-suggest", q],
    queryFn: () => apiFetch<TagSuggestion[]>(`/tags/suggest?q=${encodeURIComponent(q)}`, token).then((r) => r ?? []),
    enabled,
    staleTime: 10_000,
  });
}

// #394 / ADR-147: the local link graph around a page (mini = depth 1, modal = depth 2). Member-only; the
// server returns an edge only when the viewer can see BOTH endpoints (an unviewable page is absent as a
// node — never client-filtered here). hiddenCount reports viewable nodes dropped by the server node cap.
// Lazy: only fetched while the §Local graph section (or the modal) is open.
// #440 / ADR-166: spaceId only — NEVER a space name (names resolve via the view-filtered GET /spaces).
export interface LocalGraphNode { id: string; title: string; spaceId: string }
export interface LocalGraphEdge { from: string; to: string; type: "link" | "embed" }
export interface LocalGraphResult { center: string; nodes: LocalGraphNode[]; edges: LocalGraphEdge[]; hiddenCount: number }
export function useLocalGraph(pageId: string | null, depth: 1 | 2 | 3, enabled = true) {
  const { token } = useSession();
  return useQuery({
    queryKey: ["local-graph", pageId, depth],
    queryFn: () =>
      apiFetch<LocalGraphResult>(`/pages/${encodeURIComponent(pageId!)}/graph?depth=${depth}`, token)
        .then((r) => r ?? { center: pageId!, nodes: [], edges: [], hiddenCount: 0 }),
    enabled: enabled && pageId != null,
  });
}

// #284 / ADR-119: per-member pins (spaces + pages). The server list is view-confirmed
// (a deleted / no-longer-viewable resource is silently dropped server-side), so this
// list is authoritative for what may be rendered — never cache-render a stale title.
export type PinResourceType = "space" | "page";
export interface Pin { id: string; resourceType: PinResourceType; resourceId: string; title: string; position: number; space?: { id: string; name: string; iconImageUrl: string | null } }
export function usePins(enabled = true) {
  const { token } = useSession();
  return useQuery({
    queryKey: ["pins"],
    queryFn: () => apiFetch<Pin[]>("/pins", token).then((r) => r ?? []),
    enabled,
  });
}

export function useCreatePin() {
  const { token } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { resourceType: PinResourceType; resourceId: string }) =>
      apiFetch<Pin>("/pins", token, { method: "POST", body: JSON.stringify(args) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["pins"] }),
  });
}

export function useDeletePin() {
  const { token } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<null>(`/pins/${id}`, token, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["pins"] }),
  });
}

export function useReorderPins() {
  const { token } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { resourceType: PinResourceType; orderedIds: string[] }) =>
      apiFetch<null>("/pins/reorder", token, { method: "PATCH", body: JSON.stringify(args) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["pins"] }),
  });
}

export interface ShareLinksPage { links: ShareLink[]; nextCursor: string | null }

export function useShareLinks(resource: ShareResource | null, enabled = true) {
  const { token } = useSession();
  return useQuery({
    queryKey: ["share-links", resource?.type, resource?.id],
    // #623: the response is paged. The dialog needs the WHOLE set — it is the only place a link can be
    // revoked, and a link missing from the list is one nobody knows to take away.
    queryFn: () =>
      walkPages(
        (cursor: string | null) =>
          apiFetch<ShareLinksPage>(
            `${linksPath(resource!)}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`, token),
        (p: ShareLinksPage) => p.links,
      ),
    enabled: enabled && resource != null,
  });
}

export function useCreateShareLink() {
  const { token } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { resource: ShareResource; capability: "view" | "comment" | "edit"; expiresInSeconds: number | null; password?: string | null }) =>
      apiFetch<ShareLink>("/share-links", token, {
        method: "POST",
        body: JSON.stringify({ resource: args.resource, capability: args.capability, expiresInSeconds: args.expiresInSeconds, password: args.password ?? null }),
      }),
    onSuccess: (_l, args) => qc.invalidateQueries({ queryKey: linksKey(args.resource) }),
  });
}

export function useRevokeShareLink() {
  const { token } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; resource: ShareResource }) =>
      apiFetch<null>(`/share-links/${args.id}`, token, { method: "DELETE" }),
    onSuccess: (_r, args) => qc.invalidateQueries({ queryKey: linksKey(args.resource) }),
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
  // #486 / ADR-150 Addendum 2: author display name resolved server-side on this view-gated history
  // response (override ?? OIDC name; null = un-customized/cross-tenant/guest → the panel formats it).
  createdByName?: string | null;
  createdByHasAvatar?: boolean;
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
  const qc = useQueryClient();
  return useQuery({
    queryKey: ["published", pageId],
    queryFn: () => apiFetch<Published>(`/pages/${encodeURIComponent(pageId)}/published`, token),
    enabled: pageId.length > 0,
    // The editor is isolated from React (typing never re-renders), so nothing
    // invalidates this on a draft edit. Poll so the "unpublished changes" indicator
    // and the Publish button enable promptly after an edit persists (#10); a publish
    // invalidates immediately (clears it). Kept off the React render path on purpose
    // — driving this from an editor signal regressed the presence/awareness e2e.
    // #361 the poll PAUSES while a checkbox toggle is in flight — a poll landing between two
    // rapid toggles fetched the INTERMEDIATE committed state and repainted the box against the
    // user's optimistic flip (the residual flicker). The toggle's own onSettled coalescing (last
    // in-flight mutation only) refetches the final state once the burst settles.
    // #489 (HAR fact 2): a 404'd page id is GONE — polling it every 1.5s forever is pure waste (the
    // user's HAR showed the poll still running against a dead id). Stop on a confirmed 404; a fresh
    // navigation/mount recreates the query and polls again.
    refetchInterval: (query) => {
      if ((query.state.error as { status?: number } | null)?.status === 404) return false;
      return qc.isMutating({ mutationKey: ["toggle", pageId] }) > 0 ? false : 1500;
    },
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

// Personal account settings (ADR-020). Self-scope server-side (WHERE sub = req.user.sub).
// #289 / ADR-115: per-user editor chrome visibility. null = never enrolled → all chrome shown.
export interface EditorChromeVisibility {
  vimToggleVisible: boolean;
  modesVisible: { live: boolean; source: boolean; reading: boolean; wysiwyg: boolean };
}
export interface AccountSettings {
  displayName: string | null;         // effective: override ?? OIDC ?? null
  oidcDisplayName: string | null;     // IdP value (for the "reset to IdP name" affordance)
  displayNameOverride: string | null; // null = using the OIDC name
  identitySource: string;             // #523 / ADR-190: 'oidc' → name is IdP-managed (read-only); 'local' → editable
  editorKeymap: "default" | "vim" | "local"; // startup-mode preference (keymap)
  editorDisplayMode: "live" | "source" | "wysiwyg" | "local"; // startup display mode (ADR-056 / #164 · #289 wysiwyg)
  keybindings: Record<string, string>; // commandId → chord override (ADR-021); {} = defaults
  hasAvatar: boolean;
  editorChrome: EditorChromeVisibility | null; // #289: visibility only (startup mode stays above)
  onboardingCompletedAt: string | null; // #289: null → the first-run two-question flow fires once
  notificationsEnabled: boolean; // #362: global notification kill switch (emission-narrowing only)
  defaultEventMask: string[]; // #362: default event mask for mask-less watches ([] = all types)
  emailImmediate: boolean; // #547: mention email (default ON; under the kill switch)
  emailDigest: boolean; // #547: daily watch digest email (default OFF; under the kill switch)
}
// #379 / ADR-150: resolve author subs to display identity (customized members only — the server omits
// non-members / cross-tenant / un-customized identically, no membership oracle). Cached PER SUB (the
// ADR's implementation contract) so every surface shares one resolution; member sessions only (guests
// keep the pseudonymous formatting — the endpoint 401s them anyway; the client just never asks).
export interface MemberIdentity { displayName: string | null; hasAvatar: boolean }
export function useMemberIdentity(sub: string | null | undefined) {
  const { token, status, sub: selfSub, displayName: selfName } = useSession();
  const memberSub = sub && !sub.startsWith("guest:") && !sub.startsWith("anon:") ? sub : null;
  const q = useQuery({
    queryKey: ["member-identity", memberSub],
    enabled: status === "authed" && !!memberSub,
    staleTime: 300_000,
    queryFn: () =>
      apiFetch<{ identities: Record<string, MemberIdentity> }>("/members/identities", token, {
        method: "POST",
        body: JSON.stringify({ subs: [memberSub] }),
      }).then((r) => r?.identities?.[memberSub!] ?? null),
  });
  // #431 the caller's OWN sub resolves from the session, which already holds the canonical
  // display name (/auth/me — the same value the top-right menu and the members roster show). Without
  // this, a member who never customized their identity was absent from the endpoint (ADR-150 resolves
  // CUSTOMIZED members only, a user-ratified rule that exists so the endpoint is not a membership
  // oracle), so their own authored content fell back to the sub-derived label: "DU" in the header and
  // "DE" on the created/updated meta for the same person. Reading your own name discloses nothing, so
  // this closes the split without widening what the endpoint tells you about ANYONE ELSE.
  // The endpoint still WINS when it answers — an override must beat the OIDC name.
  const selfIdentity: MemberIdentity | null =
    memberSub != null && memberSub === selfSub && selfName ? { displayName: selfName, hasAvatar: false } : null;
  return { ...q, data: q.data ?? selfIdentity };
}

// #379: the batch form for list surfaces (history). Key = the sorted member-sub set; same server
// contract (customized-only). Small lists (history page ≤ tens of authors) — one request per set.
export function useMemberIdentities(subs: readonly string[]) {
  const { token, status, sub: selfSub, displayName: selfName } = useSession();
  const memberSubs = [...new Set(subs.filter((s) => s && !s.startsWith("guest:") && !s.startsWith("anon:")))].sort();
  const q = useQuery({
    queryKey: ["member-identities", memberSubs.join("\u0000")],
    enabled: status === "authed" && memberSubs.length > 0,
    staleTime: 300_000,
    queryFn: () =>
      apiFetch<{ identities: Record<string, MemberIdentity> }>("/members/identities", token, {
        method: "POST",
        body: JSON.stringify({ subs: memberSubs }),
      }).then((r) => r?.identities ?? {}),
  });
  // #431 same self-resolution as the single form, so a list surface (history) labels the
  // caller's own entries exactly like the header and the per-author chip. The server's answer wins.
  const withSelf = selfSub && selfName && memberSubs.includes(selfSub)
    ? { [selfSub]: { displayName: selfName, hasAvatar: false }, ...(q.data ?? {}) }
    : q.data;
  return { ...q, data: withSelf };
}

export function useAccountSettings() {
  const { token, status } = useSession();
  return useQuery({
    queryKey: ["account-settings"],
    queryFn: () => apiFetch<AccountSettings>("/me/settings", token),
    enabled: status === "authed",
    staleTime: 30_000,
  });
}
// ADR-180: the caller's own daily activity for the contribution heatmap. Self-scoped on the server
// (sub from the session, never a parameter); `tz` only chooses the day-bucket boundary. Cached longer
// than settings — a day's counts don't change minute-to-minute.
export interface ActivityDay { day: string; count: number; edits: number; comments: number } // #483 per-kind split for the tooltip
export interface MyActivity { tz: string; days: ActivityDay[] }
export function useMyActivity(tz: string) {
  const { token, status } = useSession();
  return useQuery({
    queryKey: ["me-activity", tz],
    queryFn: () => apiFetch<MyActivity>(`/me/activity?tz=${encodeURIComponent(tz)}`, token),
    enabled: status === "authed",
    staleTime: 5 * 60_000,
  });
}
export function useUpdateAccountSettings() {
  const { token } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { displayNameOverride?: string | null; editorKeymap?: "default" | "vim" | "local"; editorDisplayMode?: "live" | "source" | "wysiwyg" | "local"; keybindings?: Record<string, string>; editorChrome?: EditorChromeVisibility | null; onboardingCompleted?: boolean; notificationsEnabled?: boolean; defaultEventMask?: string[]; emailImmediate?: boolean; emailDigest?: boolean }) =>
      apiFetch<AccountSettings>("/me/settings", token, { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["account-settings"] }),
  });
}
export function useUploadAvatar() {
  const { token } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (dataBase64: string) => apiFetch("/me/avatar", token, { method: "PUT", body: JSON.stringify({ data: dataBase64 }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["account-settings"] }),
  });
}
export function useRemoveAvatar() {
  const { token } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch("/me/avatar", token, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["account-settings"] }),
  });
}

// #361 per-page SERIAL chain for task toggles. The server's no-revision fold guard demands the
// draft differ from published by EXACTLY the one claimed flip — so a rapid burst must not pile a second
// draft flip in before the first fold commits (that 409'd every request on a clean page as "publish
// first"). Each toggle's draft write (`applyFlip`) AND its POST run as one chained unit, strictly after
// the previous toggle settled: every fold sees exactly one flip, and every burst click lands in order.
// The chain lives OUTSIDE the mutation so the mutation itself still starts at click time — which is what
// keeps the refetch coalescing (isMutating counts the whole burst) and the poll gate honest.
// #361 (P0 ruling: "the animation must start on the click frame; a burst 409 is acceptable if
// that is the price of speed"): the per-page SERIAL toggle chain is GONE. It existed so every server
// fold saw exactly one draft flip, but it made each click wait for the previous round-trip — the
// sluggishness the owner reported. The server now folds every pending checkbox flip (its real
// invariant, "no non-checkbox content rides into published", is carried by the skeleton check), so
// the flip + POST can fire immediately and out of order.

// Toggle a single task checkbox on the PUBLISHED page WITHOUT creating a revision
// (ADR-019). Edit-gated server-side (the bastion); rejects 409 if the draft has any
// non-checkbox change (so it can't smuggle a real edit past history). On success the
// published snapshot changed — refetch it (and the tree badge), but NOT the revision
// list (the whole point: a checkbox tick is not history).
export function useToggleTask(pageId: string) {
  const { token } = useSession();
  const qc = useQueryClient();
  return useMutation({
    // #361 rapid toggles must COALESCE their refetches. Each click fires its own POST; if every
    // one invalidated on success, the FIRST click's refetch landed with the intermediate committed
    // state and overwrote the later click's optimistic flip (an extra blink per extra click). Keyed
    // mutations let the LAST in-flight toggle (isMutating === 1, i.e. only ourselves) do the single
    // invalidate once everything settled — intermediate toggles skip the refetch, so the widget keeps
    // the optimistic state until the final committed snapshot arrives.
    mutationKey: ["toggle", pageId],
    mutationFn: ({ index, applyFlip }: { index: number; applyFlip?: () => void; checked?: boolean }) => {
      applyFlip?.(); // the draft flip lands NOW (no chain) — see the note above
      return apiFetch<{ publishedAt: string | null }>(`/pages/${encodeURIComponent(pageId)}/tasks/toggle`, token, {
        method: "POST",
        body: JSON.stringify({ index }),
      });
    },
    // #361 the SIDEBAR ring is the one progress surface not derived from a document — it reads
    // the server's task aggregate off the page list. Patch it optimistically so all three rings (body
    // :::todo, title band, sidebar) start animating on the click frame; the refetch below reconciles
    // to the committed numbers (identical after a successful fold ⇒ no second animation).
    onMutate: ({ checked }: { index: number; applyFlip?: () => void; checked?: boolean }) => {
      if (checked === undefined) return;
      const delta = checked ? -1 : 1;
      for (const [key, data] of qc.getQueriesData<Page[]>({ queryKey: ["pages"] })) {
        if (!Array.isArray(data)) continue;
        if (!data.some((p) => p.id === pageId)) continue;
        qc.setQueryData<Page[]>(key, data.map((p) => (
          p.id === pageId
            ? { ...p, taskDone: Math.max(0, Math.min(p.taskTotal ?? 0, (p.taskDone ?? 0) + delta)) }
            : p
        )));
      }
    },
    onSettled: () => {
      if (qc.isMutating({ mutationKey: ["toggle", pageId] }) <= 1) {
        qc.invalidateQueries({ queryKey: ["published", pageId] });
        qc.invalidateQueries({ queryKey: ["pages"] });
      }
    },
  });
}

export interface RevisionsPage { revisions: Revision[]; nextCursor: string | null }

/**
 * Every row of a paged endpoint (#623), written ONCE.
 *
 * Injectable, because the loop is the part that can be wrong: stopping on an empty page instead of on a
 * null cursor, or forgetting to advance, both return a short list that looks like a complete one. There
 * is nothing on screen that says "this is where it stopped" — so it is tested directly rather than
 * through a UI assertion that would pass on any prefix.
 *
 * Stopping on an empty page is the specific failure the server's own comment warns about: authorization
 * filtering runs after the query, so a page can carry no visible row while every row after it is
 * visible.
 */
export async function walkPages<T, P extends { nextCursor: string | null }>(
  fetchPage: (cursor: string | null) => Promise<P | null>,
  rowsOf: (page: P) => T[],
): Promise<T[]> {
  const all: T[] = [];
  let cursor: string | null = null;
  // the loop condition is the CURSOR, never "the page came back empty"
  do {
    const page = await fetchPage(cursor);
    if (!page) break;
    all.push(...(rowsOf(page) ?? []));
    cursor = page.nextCursor;
  } while (cursor);
  return all;
}

/**
 * The whole page history.
 *
 * The panel MUST see the whole list. `latestRun` reads the newest contiguous run of one actor off it,
 * and a run cut at a page boundary would offer to revert more edits than the count beside it names —
 * ruled that affordance may only appear when it is honest. What is paid here is the size of one
 * response, which is what #623 is about; showing the history a page at a time is its own design.
 */
export const walkRevisions = (fetchPage: (cursor: string | null) => Promise<RevisionsPage | null>) =>
  walkPages(fetchPage, (p: RevisionsPage) => p.revisions);

export function usePageRevisions(pageId: string, enabled = true) {
  const { token } = useSession();
  return useQuery({
    queryKey: ["revisions", pageId],
    // #623: the response is paged now (one row per published version — a long-lived page has
    // hundreds). This walks to the end and returns the complete history, unchanged for every caller.
    //
    // The panel MUST see the whole list, not a first page: `latestRun` reads the newest contiguous
    // run of one actor off it, and a run cut at a page boundary would report a count smaller than the
    // number of edits it is offering to revert. ruled that affordance may only appear when it is
    // honest, so paging the panel's view of the list would need its own design — what is paid here is
    // the size of one response.
    queryFn: () =>
      walkRevisions((cursor) =>
        apiFetch<RevisionsPage>(
          `/pages/${encodeURIComponent(pageId)}/revisions${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
          token,
        ),
      ),
    enabled: enabled && pageId.length > 0,
  });
}

// Decoded Markdown of one revision (Design-5 diff). view-gated server-side. Fetched
// lazily (only when a diff is open). The client diffs it against the current published
// snapshot; the revision set is immutable, so cache it indefinitely.
export function useRevisionContent(pageId: string, revId: string | null) {
  const { token } = useSession();
  return useQuery({
    queryKey: ["revision-content", pageId, revId],
    queryFn: () => apiFetch<{ content: string }>(`/pages/${encodeURIComponent(pageId)}/revisions/${encodeURIComponent(revId!)}/content`, token).then((r) => r?.content ?? ""),
    enabled: pageId.length > 0 && !!revId,
    staleTime: Infinity,
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

// #327 / ADR-143 (increment 2): one-click revert of an actor's LATEST CONTIGUOUS run — one forward restore
// to the revision just before the run. Server-gated on moderate/manage; a 409 carries `reason`
// (not-latest / no-baseline / no-revisions) and the panel routes to the guided manual path instead.
export function useRevertActorRun(pageId: string) {
  const { token } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (actor: string) =>
      apiFetch<{ restoredToRevisionId: string; revertedCount: number }>(
        `/pages/${encodeURIComponent(pageId)}/revisions/revert-actor`, token,
        { method: "POST", body: JSON.stringify({ actor }) },
      ),
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
  canModerate?: boolean; // #330: gates moderation affordances (freeze/patrol/revert) for non-manager moderators
  canComment?: boolean; // #100: comment capability (comment_open/grant/edit) — gates the comment composer
  private?: boolean; // #109 Fix B: allowlist-only — drives the lock badge beside the title
  // #329 / ADR-139: freeze level (staged edit lock) — drives the freeze badge beside the title and the
  // permissions-dialog control. Visible to any viewer (freeze only removes access, so it leaks nothing).
  frozen?: "full" | "guests" | null;
  // #222: title-bar metadata row. createdBy = creator sub, updatedBy = last-publisher sub (option A),
  // updatedAt = last change time. Resolved to name/avatar via AuthorChip; null when unrecorded.
  createdAt?: string;
  updatedAt?: string;
  createdBy?: string | null;
  updatedBy?: string | null;
  // #486 / ADR-150 Addendum 2: author display name/avatar resolved server-side on this view-gated
  // response (override ?? OIDC name; null = un-customized/cross-tenant/guest). AuthorChip prefers it.
  createdByName?: string | null;
  createdByHasAvatar?: boolean;
  updatedByName?: string | null;
  updatedByHasAvatar?: boolean;
  // #285 (condition 1): the SAFE-side publish flag for the search preview's draft badge —
  // published_at IS NOT NULL from the view-gated getPage (NEVER the manage-gated isPagePublic).
  published?: boolean;
}

// ── per-page access (Phase 4) ──────────────────────────────────────────────
export type PageRelation = "view" | "comment" | "edit" | "manage" | "moderate"; // #100 comment grant; #330 moderate
export interface PageGrant { grantee: string; relation: PageRelation; groupName?: string; displayName?: string | null }

// #596: the revoke/unassign honesty payload. `stillCovered` names what keeps granting a capability
// after this removal (a custom role's name / a built-in capability), so surfaces can say "removed,
// but X still grants this" instead of a success toast that implies the access is gone.
// `via` is OMITTED when the caller may not read role definitions on that resource (#596 review F1:
// a page grant is `share`-gated, role names are `manage`-gated by ADR-202 §1).
export interface RevokeOutcome { removed: boolean; stillCovered: { capability: string; via?: string }[] }

export function usePageAccess(pageId: string, enabled = true) {
  const { token } = useSession();
  return useQuery({
    queryKey: ["page-access", pageId],
    // #623: paged on FGA's own token. The permissions dialog is where a grant is taken away, so a short
    // list is access nobody can revoke — it walks.
    queryFn: () =>
      walkPages(
        (c: string | null) =>
          apiFetch<{ grants: PageGrant[]; nextCursor: string | null }>(
            `/pages/${encodeURIComponent(pageId)}/access${cursorQuery(c)}`, token),
        (p: { grants: PageGrant[] }) => p.grants,
      ),
    enabled: enabled && pageId.length > 0,
  });
}

// grantee = user:<sub>/group:<id>#member (raw), OR groupName (#163: server resolves it via
// groupFgaId so the id matches the membership sync; the client never hashes).
export function useGrantAccess(pageId: string) {
  const { token } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { grantee?: string; groupName?: string; relation: PageRelation }) =>
      apiFetch<null>(`/pages/${encodeURIComponent(pageId)}/access`, token, { method: "POST", body: JSON.stringify(args) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["page-access", pageId] }),
  });
}

export function useRevokeAccess(pageId: string) {
  const { token } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { grantee?: string; groupName?: string; relation: PageRelation }) =>
      apiFetch<RevokeOutcome>(`/pages/${encodeURIComponent(pageId)}/access`, token, { method: "DELETE", body: JSON.stringify(args) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["page-access", pageId] }),
  });
}

// #109 / ADR-072 monotonic deny — the per-page restriction (deny) list, distinct from grants. A
// restricted principal 404s on the page even as a space viewer.
export interface PageRestriction { principal: string; displayName?: string | null }
export function usePageRestrictions(pageId: string, enabled = true) {
  const { token } = useSession();
  return useQuery({
    queryKey: ["page-restrict", pageId],
    // #623: paged on FGA's own token. The dialog is where a restriction is lifted, so a short list is
    // a restriction nobody can take off — it walks.
    queryFn: () =>
      walkPages(
        (c: string | null) =>
          apiFetch<{ restrictions: PageRestriction[]; nextCursor: string | null }>(
            `/pages/${encodeURIComponent(pageId)}/restrict${cursorQuery(c)}`, token),
        (p: { restrictions: PageRestriction[] }) => p.restrictions,
      ),
    enabled: enabled && pageId.length > 0,
  });
}
export function useRestrict(pageId: string) {
  const { token } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { principal?: string; groupName?: string }) =>
      apiFetch<null>(`/pages/${encodeURIComponent(pageId)}/restrict`, token, { method: "POST", body: JSON.stringify(args) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["page-restrict", pageId] }),
  });
}
export function useUnrestrict(pageId: string) {
  const { token } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { principal?: string; groupName?: string }) =>
      apiFetch<null>(`/pages/${encodeURIComponent(pageId)}/restrict`, token, { method: "DELETE", body: JSON.stringify(args) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["page-restrict", pageId] }),
  });
}

// #109 / ADR-098 — per-page PRIVATE (allowlist) toggle. Private cuts space inheritance so only the
// explicit direct grants (the access list above) can view/edit; setting it also strips public.
export function usePagePrivate(pageId: string, enabled = true) {
  const { token } = useSession();
  return useQuery({
    queryKey: ["page-private", pageId],
    queryFn: () => apiFetch<{ private: boolean }>(`/pages/${encodeURIComponent(pageId)}/private`, token).then((r) => r?.private ?? false),
    enabled: enabled && pageId.length > 0,
  });
}
export function useSetPrivate(pageId: string) {
  const { token } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (makePrivate: boolean) =>
      apiFetch<null>(`/pages/${encodeURIComponent(pageId)}/private`, token, { method: makePrivate ? "POST" : "DELETE" }),
    // Access-set and public/is_public change with privacy → refresh the access list too.
    // #109 Fix B: the private flag drives the lock badge in the tree (usePages) and beside the
    // title (usePage), so invalidate both so the lock appears/disappears immediately.
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["page-private", pageId] });
      qc.invalidateQueries({ queryKey: ["page-access", pageId] });
      qc.invalidateQueries({ queryKey: ["page", pageId] });
      qc.invalidateQueries({ queryKey: ["pages"] });
    },
  });
}

// #329 / ADR-139 — page FREEZE toggle (manage-gated server-side; the model is the fortress). level null =
// unfreeze (DELETE). The current level rides on the page payload (usePage().frozen) — no separate GET.
export function useSetFrozen(pageId: string) {
  const { token } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (level: "full" | "guests" | null) =>
      level == null
        ? apiFetch<null>(`/pages/${encodeURIComponent(pageId)}/freeze`, token, { method: "DELETE" })
        : apiFetch<null>(`/pages/${encodeURIComponent(pageId)}/freeze`, token, { method: "POST", body: JSON.stringify({ level }) }),
    // The badge (usePage) and the edit affordance (capability) both change with the freeze level.
    onSuccess: () => qc.invalidateQueries({ queryKey: ["page", pageId] }),
  });
}

// #253 / ADR-113 — per-page anonymous PUBLIC toggle (published pages only; the anonymous view_base@user:*
// grant). Manager/admin-gated server-side; the POST also requires the tenant parent switch to be ON (403).
export function usePagePublic(pageId: string, enabled = true) {
  const { token } = useSession();
  return useQuery({
    queryKey: ["page-public", pageId],
    // #253 review: `public` = the page's OWN grant (toggle state); `effectivePublic` = whether an anonymous
    // reader can actually reach it (own grant OR via a public space) — the UI warns when they diverge.
    queryFn: () =>
      apiFetch<{ public: boolean; effectivePublic: boolean }>(`/pages/${encodeURIComponent(pageId)}/public`, token).then((r) => ({
        public: r?.public ?? false,
        effectivePublic: r?.effectivePublic ?? false,
      })),
    enabled: enabled && pageId.length > 0,
  });
}
export function useSetPublic(pageId: string) {
  const { token } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (makePublic: boolean) =>
      apiFetch<null>(`/pages/${encodeURIComponent(pageId)}/public`, token, { method: makePublic ? "POST" : "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["page-public", pageId] });
      qc.invalidateQueries({ queryKey: ["page", pageId] });
    },
  });
}
// #277 / ADR-116 — space-level anonymous PUBLIC toggle (the space:S#viewer@user:* wildcard).
// Manage-gated server-side; POST also requires the tenant parent switch (403 while OFF).
export function useSpacePublic(spaceId: string, enabled = true) {
  const { token } = useSession();
  return useQuery({
    queryKey: ["space-public", spaceId],
    queryFn: () =>
      apiFetch<{ public: boolean }>(`/spaces/${encodeURIComponent(spaceId)}/public-access`, token).then((r) => r?.public ?? false),
    enabled: enabled && spaceId.length > 0,
  });
}
export function useSetSpacePublic(spaceId: string) {
  const { token } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (makePublic: boolean) =>
      apiFetch<null>(`/spaces/${encodeURIComponent(spaceId)}/public-access`, token, { method: makePublic ? "POST" : "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["space-public", spaceId] });
      // A space toggle changes every contained page's effective public reach (#253's via-space hint).
      qc.invalidateQueries({ queryKey: ["page-public"] });
    },
  });
}

// #253 / ADR-113 — the tenant PARENT SWITCH (admin-only): the master gate for the whole anonymous public
// surface. Drives whether the per-page public toggle is even offered.
export function usePublicSurface(enabled = true) {
  const { token } = useSession();
  return useQuery({
    queryKey: ["admin-public-settings"],
    queryFn: () => apiFetch<{ publicEnabled: boolean }>(`/admin/public-settings`, token).then((r) => r?.publicEnabled ?? false),
    enabled,
  });
}
export function useSetPublicSurface() {
  const { token } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (enabled: boolean) =>
      apiFetch<{ publicEnabled: boolean }>(`/admin/public-settings`, token, { method: "PUT", body: JSON.stringify({ enabled }) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["admin-public-settings"] }); },
  });
}

// #464 / ADR-175: the page analytics dashboard (who-viewed roster + guest/anon aggregate). MANAGE-gated
// server-side (a non-manager 403s, a non-viewer 404s), so it only loads where the caller manages the page.
// `entitled:false` = the tenant is not on an analytics plan (show the upgrade affordance, not the history).
export interface PageAnalytics {
  entitled: boolean;
  roster: { memberSub: string; day: string }[];
  daily: { day: string; viewerClass: "member" | "guest" | "anon"; views: number }[];
}
export function usePageAnalytics(pageId: string | null, enabled = true) {
  const { token } = useSession();
  return useQuery({
    queryKey: ["page-analytics", pageId],
    queryFn: () => apiFetch<PageAnalytics>(`/pages/${encodeURIComponent(pageId!)}/analytics`, token),
    enabled: enabled && !!pageId,
    staleTime: 60_000,
  });
}

// #520 / ADR-189: the SPACE-level page-view roll-up (aggregates page_view_daily over the pages the caller
// MANAGES — never space#viewer). MANAGE-gated server-side (a non-viewer 404s); `entitled:false` = the tenant
// is not on an analytics plan (show the upgrade affordance). Optional shaping: period (from/to), viewerClass
// filter, sort (day|views · asc|desc), and the unique toggle (member = distinct members; guest/anon stay a
// session/day approximation — the UI labels it).
export interface SpaceAnalytics {
  entitled: boolean;
  pages: number;
  unique?: boolean;
  daily: { day: string; viewerClass: "member" | "guest" | "anon"; views: number }[];
  // #595: distinct members over the WHOLE period. The daily rows are per-day distincts, so adding them up
  // counts a member once per day they returned; only the server can answer the period-wide question,
  // because it is the one holding the roster. Present in unique mode only.
  memberUnique?: number;
}
export interface SpaceAnalyticsParams { from?: string; to?: string; viewerClass?: string; unique?: boolean }
// The server-facing query string for the shaping params. Only NON-empty params are sent (so an untouched
// control never over-constrains); `unique` maps to the literal 'true' the endpoint checks for.
export function spaceAnalyticsQuery(params: SpaceAnalyticsParams): string {
  const qs = new URLSearchParams();
  if (params.from) qs.set("from", params.from);
  if (params.to) qs.set("to", params.to);
  if (params.viewerClass) qs.set("viewerClass", params.viewerClass);
  if (params.unique) qs.set("unique", "true");
  return qs.toString();
}
export function useSpaceAnalytics(spaceId: string | null, params: SpaceAnalyticsParams = {}, enabled = true) {
  const { token } = useSession();
  const q = spaceAnalyticsQuery(params);
  return useQuery({
    queryKey: ["space-analytics", spaceId, q],
    queryFn: () => apiFetch<SpaceAnalytics>(`/spaces/${encodeURIComponent(spaceId!)}/analytics${q ? `?${q}` : ""}`, token),
    enabled: enabled && !!spaceId,
    staleTime: 60_000,
    // #641 the params are in the key, so every date the reader picks is a NEW query — and without
    // this the row of controls unmounted while it resolved, taking the open calendar with it. Keeping the
    // previous answer means the surface stays put and only the numbers catch up.
    placeholderData: keepPreviousData,
  });
}

// #520 / ADR-189 slice 5/6: the TENANT-level roll-up (admin console). Same response shape and same shaping
// params as the space surface — and the same §5 manage-filter-set on the server, so even a tenant admin
// only ever sees the pages they MANAGE (a private page they don't manage stays out of the total).
export function useTenantAnalytics(params: SpaceAnalyticsParams = {}, enabled = true) {
  const { token } = useSession();
  const q = spaceAnalyticsQuery(params);
  return useQuery({
    queryKey: ["tenant-analytics", q],
    queryFn: () => apiFetch<SpaceAnalytics>(`/admin/analytics${q ? `?${q}` : ""}`, token),
    enabled,
    staleTime: 60_000,
    // #641 the params are in the key, so every date the reader picks is a NEW query — and without
    // this the row of controls unmounted while it resolved, taking the open calendar with it. Keeping the
    // previous answer means the surface stays put and only the numbers catch up.
    placeholderData: keepPreviousData,
  });
}

// #491 / ADR-140: the tenant abuse-filter config (mass-delete shrink ratio + banned words). Admin-gated
// on the server (GET/PATCH re-check tenant#admin, 403 otherwise). The banned-word list is moderation
// intelligence, so it never loads on a non-admin surface.
export interface AbuseFilterConfig { shrinkRatio: number | null; bannedWords: string[]; }
export function useAbuseFilterConfig(enabled = true) {
  const { token } = useSession();
  return useQuery({
    queryKey: ["admin-abuse-filter"],
    queryFn: () => apiFetch<AbuseFilterConfig>(`/tenant/abuse-filter`, token).then((r) => r ?? { shrinkRatio: null, bannedWords: [] }),
    enabled,
  });
}
export function useUpdateAbuseFilterConfig() {
  const { token } = useSession();
  const qc = useQueryClient();
  return useMutation({
    // the server normalizes (clamps the ratio, trims/dedups/caps the words); it returns the stored value.
    mutationFn: (cfg: AbuseFilterConfig) =>
      apiFetch<AbuseFilterConfig>(`/tenant/abuse-filter`, token, { method: "PATCH", body: JSON.stringify(cfg) }),
    onSuccess: (data) => { if (data) qc.setQueryData(["admin-abuse-filter"], data); },
  });
}

// #509 / ADR-187: the per-space abuse layer (moderate-gated on the server: space#moderator OR manager).
// GET returns the space's OWN additions, the tenant floor (read-only context), and the EFFECTIVE
// (floor ⊕ space) policy that a publish is actually judged against. A `null` field = inherit.
export interface SpaceAbuseLayer { shrinkRatio: number | null; bannedWords: string[] | null; }
export interface SpaceAbuseFilterResponse { space: SpaceAbuseLayer; tenantFloor: AbuseFilterConfig; effective: AbuseFilterConfig; }
export function useSpaceAbuseFilterConfig(spaceId: string | undefined, enabled = true) {
  const { token } = useSession();
  return useQuery({
    queryKey: ["space-abuse-filter", spaceId],
    queryFn: () => apiFetch<SpaceAbuseFilterResponse>(`/spaces/${spaceId}/abuse-filter`, token),
    enabled: enabled && !!spaceId,
  });
}
export function useUpdateSpaceAbuseFilterConfig(spaceId: string | undefined) {
  const { token } = useSession();
  const qc = useQueryClient();
  return useMutation({
    // The server normalizes and UNIONs / MAXes with the tenant floor; a null field clears the space layer.
    mutationFn: (layer: SpaceAbuseLayer) =>
      apiFetch<SpaceAbuseLayer>(`/spaces/${spaceId}/abuse-filter`, token, { method: "PATCH", body: JSON.stringify(layer) }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["space-abuse-filter", spaceId] }); },
  });
}

// The tenant's group-name source for the group-grant picker (#163). manage-gated server-side
// (group names can be sensitive), so scope the query to a space the caller manages.
// #579: the TENANT-scope group name source, for assigning a tenant role to a group from the admin
// console. The space-scoped list above is gated on that space's `manage` and needs a space id, which
// the console does not have; this one is tenant-admin gated. Names only — the id stays server-derived.
export interface GroupNamesPage { groups: string[]; nextCursor: string | null }

/** `?cursor=…`, or nothing on the first request. */
export const cursorQuery = (cursor: string | null) => (cursor ? `?cursor=${encodeURIComponent(cursor)}` : "");

/** #623: both group-name lists walk, and they walk the same way. */
export const walkGroupNames = (fetchPage: (cursor: string | null) => Promise<GroupNamesPage | null>) =>
  walkPages(fetchPage, (p: GroupNamesPage) => p.groups);

export function useTenantGroupNames() {
  const { token } = useSession();
  return useQuery({
    queryKey: ["tenant-group-names"],
    // #623: paged. The picker completes a grantee out of this list, so a short one silently makes some
    // groups un-grantable — it walks to the end.
    queryFn: () => walkGroupNames((c) => apiFetch<GroupNamesPage>(`/admin/groups${cursorQuery(c)}`, token)),
  });
}
export function useTenantGroups(spaceId: string, enabled = true) {
  const { token } = useSession();
  return useQuery({
    queryKey: ["tenant-groups", spaceId],
    queryFn: () =>
      walkGroupNames((c) =>
        apiFetch<GroupNamesPage>(`/spaces/${encodeURIComponent(spaceId)}/groups${cursorQuery(c)}`, token)),
    enabled: enabled && spaceId.length > 0,
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
// #523 / ADR-190 slice A: the server resolves a USER grantee's full name (override ?? OIDC display_name)
// over this manage-gated set, so an un-customized member reads as their name, not a sub. null for a
// departed / cross-tenant sub (client keeps the sub); absent for group grantees.
// #578 bounce ①: `groupUnconfirmed` = the name was typed for a group the directory has not produced
// yet. It is a real name and is shown as one; the flag only changes what the row says beside it.
// #607 / ADR-209: `revocable` — whether THIS caller may take the row away (an access-manager sees the
// manager/moderator rows but cannot revoke them; a bare × would be a button that answers 403).
// #607 (review rejection): `changeable` — whether this caller may change THIS PRINCIPAL's role.
// Different question from `revocable`, and the difference is the defect: a role change is a replace over
// everything the principal holds, so a principal's revocable `view` row is not evidence that their role
// can be moved (theirs was also the space's owner).
export interface SpaceGrant { grantee: string; capability: PageRelation | "manageAccess"; groupName?: string; groupUnconfirmed?: boolean; displayName?: string | null; managed?: boolean; revocable?: boolean; changeable?: boolean }
export interface MemberCandidate { sub: string; displayName: string | null }

export function useSpaceAccess(spaceId: string, enabled = true) {
  const { token } = useSession();
  return useQuery({
    queryKey: ["space-access", spaceId],
    // #623: paged on FGA's own token. The permissions screen is where a grant is taken away, and #607
    // made each row say whether THIS caller may take it — a roster missing rows is access nobody can
    // act on. It walks.
    queryFn: () =>
      walkPages(
        (c: string | null) =>
          apiFetch<{ grants: SpaceGrant[]; nextCursor: string | null }>(
            `/spaces/${encodeURIComponent(spaceId)}/access${cursorQuery(c)}`, token),
        (p: { grants: SpaceGrant[] }) => p.grants,
      ),
    enabled: enabled && spaceId.length > 0,
  });
}
export function useGrantSpaceAccess(spaceId: string) {
  const { token } = useSession();
  const qc = useQueryClient();
  return useMutation({
    // The API body keys the capability as `relation` (shared page/space vocabulary). grantee OR
    // groupName (#163: server resolves the group name → group:<id>#member). #553: `capabilities`
    // (plural) is the composite form — the editor noun grants its bundle atomically via `relations`.
    // #536 `replace` is the caller saying a PERSON confirmed demoting a manager. Without it the
    // server refuses (409 manager_replacement_requires_confirmation) rather than silently demoting.
    mutationFn: (args: { grantee?: string; groupName?: string; capability?: PageRelation; capabilities?: string[]; replace?: boolean }) =>
      apiFetch<null>(`/spaces/${encodeURIComponent(spaceId)}/access`, token, {
        method: "POST",
        body: JSON.stringify(
          args.capabilities
            ? { grantee: args.grantee, groupName: args.groupName, relations: args.capabilities, replace: args.replace }
            : { grantee: args.grantee, groupName: args.groupName, relation: args.capability, replace: args.replace },
        ),
      }),
    // #578 (review rejection, 2026-08-04): a grant REPLACES whatever role the principal held, including a
    // custom-role assignment (the server sweeps it) — so the assignment listing is stale the moment this
    // succeeds. Invalidating only our own side left the old row standing next to the new one: the screen
    // showed "1 person, 2 roles" while the store held one. Both queries move, both are told.
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["space-access", spaceId] });
      qc.invalidateQueries({ queryKey: ["role-assignments", "space", spaceId] });
    },
  });
}
export function useRevokeSpaceAccess(spaceId: string) {
  const { token } = useSession();
  const qc = useQueryClient();
  return useMutation({
    // #553 (a): `capabilities` is the folded-noun form — one request, one server transaction, so a
    // half-revoked principal is not reachable by a client that stops between two calls.
    mutationFn: (args: { grantee?: string; groupName?: string; capability?: PageRelation; capabilities?: string[] }) =>
      apiFetch<RevokeOutcome>(`/spaces/${encodeURIComponent(spaceId)}/access`, token, {
        method: "DELETE",
        body: JSON.stringify(
          args.capabilities
            ? { grantee: args.grantee, groupName: args.groupName, relations: args.capabilities }
            : { grantee: args.grantee, groupName: args.groupName, relation: args.capability },
        ),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["space-access", spaceId] }),
  });
}
// Space comment-audience setting (#100 / ADR-029): who may comment on the space's pages — guests
// (any view link) and/or public members. manage-gated. Toggling writes/deletes the wildcard
// comment_open tuples; page `comment` derives from it. Default OFF (anti-grief).
export interface CommentOpenDTO { guests: boolean; members: boolean }
export function useCommentOpen(spaceId: string, enabled = true) {
  const { token } = useSession();
  return useQuery({
    queryKey: ["comment-open", spaceId],
    queryFn: () => apiFetch<CommentOpenDTO>(`/spaces/${encodeURIComponent(spaceId)}/comment-open`, token),
    enabled: enabled && spaceId.length > 0,
  });
}
export function useSetCommentOpen(spaceId: string) {
  const { token } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { guests?: boolean; members?: boolean }) =>
      apiFetch<CommentOpenDTO>(`/spaces/${encodeURIComponent(spaceId)}/comment-open`, token, { method: "PATCH", body: JSON.stringify(args) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["comment-open", spaceId] }),
  });
}

// Tenant branding (Phase 5d). GET /branding is PUBLIC (resolved from the Host) so
// it works for members, guests, and unauthenticated visitors — it drives the header
// wordmark and the tenant layer of the accent cascade. The server strips branding
// when the plan isn't entitled.
export interface BrandingDTO { displayName: string | null; accentKey: string | null; logoUrl: string | null; whitelabel?: boolean; productName?: string } // #430: paid = white-label public pages
export function useBranding() {
  const { token } = useSession();
  return useQuery({
    queryKey: ["branding"],
    queryFn: () => apiFetch<BrandingDTO>("/branding", token),
    staleTime: 60_000,
  });
}
// #108 / ADR-071: the tenant's external-embed host allowlist for the client-direct sandboxed iframe.
// PUBLIC + host-resolved (like /branding). Empty ⇒ external embeds all degrade to a link (opt-in off).
// #224 / ADR-104: the viewer-scoped title dictionary for auto internal links. The server derives the
// set per principal (member = own FGA view set / guest = public-only) — the dictionary content IS the
// authz defence, so nothing here filters. staleTime + refetchInterval are the TTL backstop for surfaces
// without a collab connection; the collab stateless "dict-invalidate" ping invalidates this key for
// connected editors (the security-timing channel).
export function useTitleDictionary(pageId: string | undefined) {
  const { token } = useSession();
  // #541: the dictionary yields the road at page-open. It is the single most expensive authorization
  // fan-out a page load fires (a batch-check confirm over up to 2000 ids), and it went out in the same
  // burst as everything else — so on a busy FGA the surfaces someone is actually waiting for (the space
  // list, the page tree, the page itself) queued behind it, and the sidebar sat empty for seconds while
  // an ENHANCEMENT (auto internal links) hogged the checker.
  //
  // a FIXED 1.5s hold-back was the wrong shape, and it is exactly what made the sidebar BIMODAL
  // (2.7s or 7.8s, nothing between — measured timelines): the tree request takes a variable time, and
  // whenever it was still in flight at the 1.5s mark the dictionary burst landed on top of it and the
  // tree crawled (measured: 4.8s for the same request that takes 1.0s uncontended). So the yield now
  // waits for the thing it is actually yielding TO: while any space-list or page-tree query is in
  // flight, the dictionary holds. A short floor covers the mount gap before those queries start (the
  // tree only starts once /spaces resolves, so a bare isFetching==0 at mount would fire straight into
  // the burst), and a hard cap keeps links from being deferred forever on surfaces where no tree ever
  // loads. Links simply fill in a moment later, which they already did anyway (the dictionary is
  // best-effort by design — see retry:false below).
  // scroll-isolation (#538): NOT useIsFetching — that hook re-renders its host on EVERY query state
  // change, and this hook lives in the Editor, so widget fetches during scroll re-rendered the editor
  // (the scroll-isolation pin went red). The watch is a plain cache subscription that only ever calls
  // setState ONCE (to yield) and unsubscribes itself; after that the editor hears nothing.
  const qc = useQueryClient();
  const [yielded, setYielded] = useState(false);
  useEffect(() => {
    if (yielded) return;
    let floorPassed = false;
    const check = () => {
      if (!floorPassed) return;
      if (qc.isFetching({ queryKey: ["spaces"] }) + qc.isFetching({ queryKey: ["pages"] }) === 0) setYielded(true);
    };
    const floor = setTimeout(() => { floorPassed = true; check(); }, 700);
    const cap = setTimeout(() => setYielded(true), 8000);
    const unsub = qc.getQueryCache().subscribe(check);
    return () => { clearTimeout(floor); clearTimeout(cap); unsub(); };
  }, [yielded, qc]);
  return useQuery({
    // (#541): keyed on the VIEWER, not the page. The member dictionary is subject-scoped on the
    // server (the pageId in the URL is only the existence-gated anchor), so a per-page key made every
    // navigation refire the most expensive authz fan-out the app has — and a browse session paid it on
    // each hop. One key = one dictionary per session window (staleTime below); the collab
    // dict-invalidate ping already invalidates by prefix, so revocation timing is unchanged.
    queryKey: ["title-dictionary"],
    enabled: !!pageId && yielded,
    queryFn: () => apiFetch<{ entries: { id: string; title: string }[]; capped: boolean; degraded?: boolean }>(`/pages/${encodeURIComponent(pageId!)}/title-dictionary`, token),
    staleTime: 30_000,
    refetchInterval: 120_000,
    // #489 (remedy 1): the dictionary is BEST-EFFORT — an enhancement (auto internal links),
    // never worth stacking retries against a struggling server (the HAR showed retry:1 turning one
    // 3.2s deadline-500 into ~6.5s of foreground pain). No immediate retry; the 120s interval is the
    // gentle background recovery, and a failed dict simply renders links as plain text.
    retry: false,
  });
}

export function useEmbedProviders() {
  const { token } = useSession();
  return useQuery({
    queryKey: ["embed-providers"],
    queryFn: () => apiFetch<{ providers: string[] }>("/embed/providers", token),
    staleTime: 60_000,
  });
}
// #108 bounce: a tenant admin edits the external-embed host allowlist. PUT is admin-gated server-side
// (non-admin → 403); the server normalises entries to bare hostnames and returns the stored list.
export function useUpdateEmbedProviders() {
  const { token } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (providers: string[]) =>
      apiFetch<{ providers: string[] }>("/embed/providers", token, { method: "PUT", body: JSON.stringify({ providers }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["embed-providers"] }),
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

// Upload/remove a space icon IMAGE. base64 in (no multipart); the server validates
// magic bytes + size. Unset → the sidebar shows the initials chip.
export function useUploadSpaceIcon(spaceId: string) {
  const { token } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (dataBase64: string) =>
      apiFetch<null>(`/spaces/${encodeURIComponent(spaceId)}/icon-image`, token, { method: "POST", body: JSON.stringify({ data: dataBase64 }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["spaces"] }),
  });
}
export function useRemoveSpaceIcon(spaceId: string) {
  const { token } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<null>(`/spaces/${encodeURIComponent(spaceId)}/icon-image`, token, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["spaces"] }),
  });
}

// Billing (Phase 5g). billingEnabled is false on self-host (no Stripe) → the UI
// shows "self-hosted" instead of upgrade/manage. checkout/portal return a Stripe
// URL the client redirects to.
export interface BillingStatus { plan: string; billingEnabled: boolean }
export function useBillingStatus() {
  const { token } = useSession();
  return useQuery({ queryKey: ["billing-status"], queryFn: () => apiFetch<BillingStatus>("/billing/status", token), staleTime: 30_000 });
}
// #231: what has been METERED this period, beside the allowance the plan already carries. Read-only
// and number-free on purpose — prices, cap constants and soft-cap enforcement are #127's rulings, and
// a screen that guessed at them would have to be rebuilt when they land. `allowance: null` means
// unlimited (JSON has no Infinity; a serialiser would otherwise turn it into a `null` that reads as
// zero). tenant#admin server-side: a non-admin gets 403 and the section simply does not render.
export interface UsageResource { resource: string; used: number; allowance: number | null }
export interface UsageDTO { periodStart: string; plan: string; resources: UsageResource[] }
export function useBillingUsage() {
  const { token } = useSession();
  return useQuery({
    queryKey: ["billing-usage"],
    queryFn: () => apiFetch<UsageDTO>("/billing/usage", token),
    staleTime: 30_000,
    retry: false, // a 403 is an answer, not a hiccup
  });
}
export function useCheckout() {
  const { token } = useSession();
  return useMutation({ mutationFn: (plan: string) => apiFetch<{ url: string }>("/billing/checkout", token, { method: "POST", body: JSON.stringify({ plan }) }) });
}
export function usePortal() {
  const { token } = useSession();
  return useMutation({ mutationFn: () => apiFetch<{ url: string }>("/billing/portal", token, { method: "POST" }) });
}

// API keys (Phase 5f). Per-member ownership; scope ('read'|'write') restricts a key
// below its owner's authority. The tenant policy caps issuable scope.
export type ApiScope = "read" | "write";
export interface ApiKeySummary { id: string; name: string; keyPrefix: string; scope: ApiScope; createdAt: string; lastUsedAt: string | null;
  // #628 / ADR-215 §1: when the key stops working on its own. null = never — every key issued before
  // the feature, and every key whose owner did not ask for a lifetime.
  expiresAt?: string | null;
  // #495 / ADR-182: present ONLY on the admin list (GET /api-keys) so an admin can revoke a specific
  // member's key. ownerName follows #486 (null → null, no email fallback). Never a secret.
  ownerUserId?: string; ownerName?: string | null;
  // #658: what the key is confined to, so a roster of credentials can be read back. Absent when the key
  // is not confined in that dimension — the common case carries no marking, so the exception is what
  // stands out. `spaces.count` is every space on the key; `spaces.named` only the ones this reader may
  // view, which is why the two can differ.
  capabilities?: string[];
  spaces?: { count: number; named: { id: string; name: string }[] };
  // #667 / ADR-221 §3: which rule reads this key — 1 is the six borrowed verbs against the frozen route
  // table, 2 the resource-type matrix. Always present, so the panel can mark the older ones without
  // guessing from the absence of a field.
  permissionModel?: 1 | 2;
  permissions?: Record<string, string> }
export interface ApiKeyCreated extends ApiKeySummary { plaintext: string }
// #462: two lists, because they answer different questions. `useApiKeys` is the tenant-wide ADMIN
// view (it used to be readable by any member, which laid out who automates what); `useMyApiKeys` is
// the member's own keys, which is all a self-serve surface should show.
export function useApiKeys() {
  const { token } = useSession();
  return useQuery({ queryKey: ["api-keys"], queryFn: () => apiFetch<ApiKeySummary[]>("/api-keys", token).then((r) => r ?? []) });
}
export function useMyApiKeys(enabled = true) {
  const { token } = useSession();
  return useQuery({ queryKey: ["api-keys", "mine"], queryFn: () => apiFetch<ApiKeySummary[]>("/api-keys/mine", token).then((r) => r ?? []), enabled });
}
// What the CALLER may do here — for showing or hiding the affordance only. The server refuses
// regardless of what this says.
// #496 / ADR-181: the `policy` enum field is gone — `canIssue` IS the server's capability check
// (isApiKeyIssuer), so this can never disagree with the gate.
export interface ApiKeyPolicy { canIssue: boolean; maxScope: ApiScope; maxAgeDays?: number | null }
export function useMyApiKeyPolicy() {
  const { token } = useSession();
  return useQuery({ queryKey: ["api-keys", "policy"], queryFn: () => apiFetch<ApiKeyPolicy>("/api-keys/policy", token) });
}
export function useCreateApiKey() {
  const { token } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { name: string; scope: ApiScope; expiresInDays?: number | null }) => apiFetch<ApiKeyCreated>("/api-keys", token, { method: "POST", body: JSON.stringify(args) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["api-keys"] }), // refreshes both lists (shared key prefix)
  });
}
// #637 / ADR-216: issuing a NARROWED key. A separate mutation rather than optional fields on the one
// above, because it is a separate ROUTE — narrowing is EE, so a deployment without the overlay does not
// have it, and a 404 is the honest answer there rather than a key that quietly comes back unnarrowed.
export function useCreateNarrowedApiKey() {
  const { token } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { name: string; scope: ApiScope; expiresInDays?: number | null; capabilities?: string[] | null; spaces?: string[] | null; permissions?: Record<string, string> | null }) =>
      apiFetch<ApiKeyCreated>("/admin/api-keys/narrowed", token, { method: "POST", body: JSON.stringify(args) }),
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
// #495 / ADR-182: the ADMIN revoke — kill ANY member's key via the admin-gated route (server re-checks
// tenant#admin; a non-admin 403s). Distinct from useRevokeApiKey (owner self-serve).
export function useAdminRevokeApiKey() {
  const { token } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<null>(`/admin/api-keys/${encodeURIComponent(id)}`, token, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["api-keys"] }),
  });
}

// #228 / ADR-108: outbound webhooks (admin console CRUD). The secret is returned ONCE on creation.
export interface WebhookSummary { id: string; url: string; event_filter: string[] | null; active: boolean; failure_count: number; createdAt: string }
export interface WebhookCreated { id: string; secret: string }
// #401 / ADR-155: the audit-log viewer (tenant-admin + auditLog entitlement; server re-checks both).
export interface AuditRow { seq: number; at: string; actor: string; action: string; target: string }
export interface AuditVerdict { valid: boolean; count: number; brokenAt?: number; brokenSeq?: number; reason?: string }

// #420 / ADR-164 increment 5: custom-role definitions + assignments (tenant-admin console; the
// server enforces the admin gate + customRoles entitlement on writes — UI is convenience only).
export interface RoleDef { id: string; name: string; capabilities: string[]; scope: "resource" | "tenant" }
export interface RoleListPage {
  builtIn: { name: string; capabilities: string[] }[];
  custom: RoleDef[];
  nextCursor: string | null;
}

/**
 * #623: the three role lists are paged. Every screen that reads one needs the WHOLE set — the pickers
 * complete a role out of it, so a short list silently makes some roles unassignable, and the admin tab
 * is where a role is edited or deleted.
 *
 * `builtIn` comes back whole on every page (it is a constant, not a query), so the first page's copy is
 * the answer; only `custom` accumulates.
 */
async function walkRoleList(
  fetchPage: (cursor: string | null) => Promise<RoleListPage | null>,
): Promise<{ builtIn: RoleListPage["builtIn"]; custom: RoleDef[] }> {
  const custom: RoleDef[] = [];
  let builtIn: RoleListPage["builtIn"] = [];
  let cursor: string | null = null;
  let first = true;
  // the loop condition is the CURSOR, never "the page came back empty"
  do {
    const page: RoleListPage | null = await fetchPage(cursor);
    if (!page) break;
    if (first) { builtIn = page.builtIn ?? []; first = false; }
    custom.push(...(page.custom ?? []));
    cursor = page.nextCursor ?? null;
  } while (cursor);
  return { builtIn, custom };
}

export function useRoles(enabled = true) {
  const { token } = useSession();
  return useQuery({
    queryKey: ["roles"],
    queryFn: () => walkRoleList((c) => apiFetch<RoleListPage>(`/admin/roles${cursorQuery(c)}`, token)),
    enabled,
  });
}
export function useCreateRole() {
  const { token } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; capabilities: string[]; scope?: "resource" | "tenant" }) =>
      apiFetch<RoleDef>("/admin/roles", token, { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["roles"] }),
  });
}
export function useUpdateRole() {
  const { token } = useSession();
  const qc = useQueryClient();
  type Roles = { builtIn: { name: string; capabilities: string[] }[]; custom: RoleDef[] };
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string; name: string; capabilities: string[] }) =>
      apiFetch<RoleDef>(`/admin/roles/${encodeURIComponent(id)}`, token, { method: "PUT", body: JSON.stringify(body) }),
    // #445 the inline capability toggle commits per-op, so the checkbox must MOVE on click —
    // a controlled box that waits for the invalidate/refetch reads as a dead click. Standard optimistic
    // pattern: patch the cache immediately, roll back on error (the 403/409 toast explains why), and
    // settle with the invalidate so the server row is the final truth either way.
    onMutate: (vars) => {
      // Patch SYNCHRONOUSLY (before any await) so the re-render lands in the same event batch as the
      // click — the checkbox flips in the frame it was clicked in. cancelQueries follows in the same
      // tick to stop an in-flight refetch from overwriting the patch; onSettled re-invalidates anyway.
      const prev = qc.getQueryData<Roles>(["roles"]);
      qc.setQueryData<Roles>(["roles"], (cur) =>
        cur ? { ...cur, custom: cur.custom.map((r) => (r.id === vars.id ? { ...r, name: vars.name, capabilities: vars.capabilities } : r)) } : cur,
      );
      void qc.cancelQueries({ queryKey: ["roles"] });
      return { prev };
    },
    onError: (_e, _v, ctx) => { if (ctx?.prev) qc.setQueryData(["roles"], ctx.prev); },
    onSettled: () => qc.invalidateQueries({ queryKey: ["roles"] }),
  });
}
export function useDeleteRole() {
  const { token } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(`/admin/roles/${encodeURIComponent(id)}`, token, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["roles"] }),
  });
}
// #523 / ADR-190 (slice E): `displayName` is the server-resolved name of a USER principal (override ?? OIDC
// name), present only for user principals and null when the sub is cross-tenant/departed — the client falls
// back to the raw sub. A group principal is a HASH (groupFgaId is one-way) — the server resolves it
// back to the human name (`groupName`, #536); absent means the group no longer exists at the IdP
// (the UI shows its explicit orphan label, never the hash).
// #603 / ADR-207: `roleId` is null and `builtin` names the tier when the row is a BUILT-IN grant — the
// mechanism, not the name, is what tells it apart from a custom role that took the same name.
export interface RoleAssignment { id: string; roleId: string | null; roleName: string; builtin?: string; principal: string; displayName?: string | null; groupName?: string; groupUnconfirmed?: boolean; managed?: boolean }
export function useRoleAssignments(resourceType: string, resourceId: string, enabled = true) {
  const { token } = useSession();
  return useQuery({
    queryKey: ["role-assignments", resourceType, resourceId],
    queryFn: () => apiFetch<RoleAssignment[]>(`/admin/roles/assignments?resourceType=${encodeURIComponent(resourceType)}&resourceId=${encodeURIComponent(resourceId)}`, token).then((r) => r ?? []),
    enabled: enabled && resourceId.length > 0,
  });
}
export function useAssignRole() {
  const { token } = useSession();
  const qc = useQueryClient();
  return useMutation({
    // #536 `groupName` is the group form — the server derives its tenant-salted FGA id. A client
    // that sends a hand-built `group:<name>#member` principal writes a tuple nobody holds.
    mutationFn: ({ roleId, ...body }: { roleId: string; resourceType: string; resourceId: string; principal?: string; groupName?: string; replace?: boolean }) =>
      apiFetch<RoleAssignment>(`/admin/roles/${encodeURIComponent(roleId)}/assignments`, token, { method: "POST", body: JSON.stringify(body) }),
    // #578 (review rejection, 2026-08-04): assigning over a built-in SPACE grant sweeps that grant
    // (1 principal = 1 role converges server-side), so the grant listing is stale too — without this
    // the swept row stayed on screen beside the new one until a reload.
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ["role-assignments"] });
      if (vars.resourceType === "space") qc.invalidateQueries({ queryKey: ["space-access", vars.resourceId] });
    },
  });
}
// ADR-207 §R4-3 (#603): the tenant TIER grant — a capability (admin | member), never a role id, and
// groups only (a person's tier is their member row). The server derives the group's FGA id from the
// name (#536 the client never hashes); a principal straight from the assignments listing is
// also accepted.
export function useAssignTenantTier() {
  const { token } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { capability: "admin" | "member"; groupName?: string; principal?: string }) =>
      apiFetch<RoleAssignment>(`/admin/roles/tenant-tier-assignments`, token, { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["role-assignments"] }),
  });
}
export function useUnassignRole() {
  const { token } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (assignmentId: string) => apiFetch<RevokeOutcome>(`/admin/roles/assignments/${encodeURIComponent(assignmentId)}`, token, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["role-assignments"] }),
  });
}
// #485 / #514: the role DEFINITIONS a SPACE MANAGER may assign in-space — built-ins + custom RESOURCE-scope
// roles, read-only, manager-gated server-side (GET /admin/roles is tenant-admin-only, unreachable here).
export function useAssignableRoles(spaceId: string, enabled = true) {
  const { token } = useSession();
  return useQuery({
    queryKey: ["assignable-roles", spaceId],
    queryFn: () =>
      walkRoleList((c) => apiFetch<RoleListPage>(`/spaces/${encodeURIComponent(spaceId)}/assignable-roles${cursorQuery(c)}`, token)),
    enabled: enabled && spaceId.length > 0,
  });
}

// #582 / ADR-202 §1: the same list for a PAGE. It is its own endpoint because a page-only manager
// cannot read the space one (that is gated on SPACE manage), and its own query key because the two
// answer for different resources.
export function usePageAssignableRoles(pageId: string, enabled = true) {
  const { token } = useSession();
  return useQuery({
    queryKey: ["page-assignable-roles", pageId],
    queryFn: () =>
      walkRoleList((c) => apiFetch<RoleListPage>(`/pages/${encodeURIComponent(pageId)}/assignable-roles${cursorQuery(c)}`, token)),
    enabled: enabled && pageId.length > 0,
  });
}

// #497 / ADR-183 → RETIRED by #578 / ADR-201 (slices 3 and 7): group mappings are gone, and with them
// the four hooks that read, created and deleted them. A group takes a role the same way a person does
// — the tenant assignment for a tenant role, the space grant for a space one — so there is one client
// path to the same result instead of two. The server answers 410 on the old routes.

// #497 / ADR-183 §3: the tenant DEFAULT role — a tenant-scope custom role conferred on any member no
// #578 / ADR-201 slice 5: the tenant default role is retired (its meaning moved to the every-member
// toggles on the same screen), so the two hooks that read and wrote it are gone with their routes.

export function useAuditLog(before: number | null, enabled = true) {
  const { token } = useSession();
  return useQuery({
    queryKey: ["audit-log", before],
    queryFn: () => apiFetch<AuditRow[]>(`/audit?limit=50${before != null ? `&before=${before}` : ""}`, token).then((r) => r ?? []),
    enabled,
    staleTime: 5_000,
  });
}

export function useAuditVerify() {
  const { token } = useSession();
  return useMutation({ mutationFn: () => apiFetch<AuditVerdict>(`/audit/verify`, token) });
}

// #399 / ADR-158: permission-policy knobs (restrict-only; the server is the fortress).
export function usePageCommentAudience(pageId: string | null, enabled = true) {
  const { token } = useSession();
  return useQuery({
    queryKey: ["page-comment-audience", pageId],
    queryFn: () => apiFetch<{ guests: boolean; members: boolean }>(`/pages/${encodeURIComponent(pageId!)}/comment-audience`, token),
    enabled: enabled && pageId != null && pageId.length > 0,
  });
}
export function useSetPageCommentAudience(pageId: string | null) {
  const { token } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { guests?: boolean; members?: boolean }) =>
      apiFetch<{ guests: boolean; members: boolean }>(`/pages/${encodeURIComponent(pageId!)}/comment-audience`, token, { method: "PUT", body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["page-comment-audience", pageId] }),
  });
}
// #445 / ADR-171: the DEFAULT tenant-role presets (CE — replaces the #399 §2 creation-policy knob).
// member.createSpaces IS the tenant#space_creator userset tuple; admin is locked-on by the model.
// #496 / ADR-181: member.issueApiKeys is the same thing for `api_key_issue` (the retired #462 policy
// enum) — both toggles write/delete one member-userset tuple, and both are model-locked for admins.
export interface TenantRoleDefaults {
  member: { createSpaces: boolean; issueApiKeys: boolean }
  admin: { createSpaces: boolean; issueApiKeys: boolean; locked: boolean }
}
export function useTenantRoleDefaults(enabled = true) {
  const { token } = useSession();
  return useQuery({
    queryKey: ["tenant-role-defaults"],
    queryFn: () => apiFetch<TenantRoleDefaults>(`/admin/roles/tenant-defaults`, token),
    enabled,
  });
}
export function useSetTenantRoleDefaults() {
  const { token } = useSession();
  const qc = useQueryClient();
  return useMutation({
    // #496: a PATCH shape — the server touches only the fields present, so a caller may flip one member
    // toggle without naming the other (the Roles tab sends both because the picker knows both current
    // values; a caller that knows only one, e.g. a test or a future single-switch UI, sends just that one).
    mutationFn: (patch: { memberCreateSpaces?: boolean; memberIssueApiKeys?: boolean }) =>
      apiFetch<TenantRoleDefaults>(`/admin/roles/tenant-defaults`, token, { method: "PUT", body: JSON.stringify(patch) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tenant-role-defaults"] }),
  });
}
export function usePageCreationPolicy(spaceId: string, enabled = true) {
  const { token } = useSession();
  return useQuery({
    queryKey: ["page-creation-policy", spaceId],
    queryFn: () => apiFetch<{ pageCreationPolicy: string }>(`/spaces/${encodeURIComponent(spaceId)}/page-creation-policy`, token),
    enabled: enabled && spaceId.length > 0,
  });
}
export function useSetPageCreationPolicy(spaceId: string) {
  const { token } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: string) => apiFetch<{ pageCreationPolicy: string }>(`/spaces/${encodeURIComponent(spaceId)}/page-creation-policy`, token, { method: "PUT", body: JSON.stringify({ pageCreationPolicy: v }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["page-creation-policy", spaceId] }),
  });
}

export function useWebhooks() {
  const { token } = useSession();
  // #623: the route answers a bounded page now. The screen still shows a list, so the page is unwrapped
  // here rather than every caller learning about the envelope.
  return useQuery({
    queryKey: ["webhooks"],
    queryFn: () => apiFetch<{ webhooks: WebhookSummary[]; nextCursor: string | null }>("/webhooks", token)
      .then((r) => r?.webhooks ?? []),
  });
}
export function useCreateWebhook() {
  const { token } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { url: string; eventFilter?: string[] | null }) => apiFetch<WebhookCreated>("/webhooks", token, { method: "POST", body: JSON.stringify(args) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["webhooks"] }),
  });
}
export function useDeleteWebhook() {
  const { token } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<null>(`/webhooks/${encodeURIComponent(id)}`, token, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["webhooks"] }),
  });
}
export function useApiPolicy() {
  const { token } = useSession();
  return useQuery({ queryKey: ["api-policy"], queryFn: () => apiFetch<{ maxScope: ApiScope; maxAgeDays: number | null }>("/admin/api-policy", token) });
}
// #496: only the scope cap is set here now — "who may issue" moved to the Roles tab (ADR-181 §5).
export function useUpdateApiPolicy() {
  const { token } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: { maxScope?: ApiScope; maxAgeDays?: number | null }) =>
      apiFetch<null>("/admin/api-policy", token, { method: "PATCH", body: JSON.stringify(patch) }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["api-policy"] }); void qc.invalidateQueries({ queryKey: ["api-keys"] }); },
  });
}

// Orphan-draft admin handoff (#99 / ADR-061) — tenant#admin only. Enumerate stranded
// strict-private drafts, then claim (temp access) → reassign to a member. The server holds
// all authz: a non-admin 404s, claim re-checks the orphan condition (a live page can't be
// claimed), reassign revokes the admin's temp grant.
export interface OrphanDraftDTO { id: string; title: string; createdAt: string }
export function useOrphanDrafts() {
  const { token } = useSession();
  return useQuery({
    queryKey: ["orphan-drafts"],
    queryFn: () => apiFetch<OrphanDraftDTO[]>("/admin/orphan-drafts", token).then((r) => r ?? []),
  });
}
export function useClaimOrphanDraft() {
  const { token } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (pageId: string) => apiFetch<{ pageId: string; expiresAt: string }>(`/admin/orphan-drafts/${encodeURIComponent(pageId)}/claim`, token, { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["orphan-drafts"] }),
  });
}
export function useReassignOrphanDraft() {
  const { token } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { pageId: string; to: string }) => apiFetch<null>(`/admin/orphan-drafts/${encodeURIComponent(args.pageId)}/reassign`, token, { method: "POST", body: JSON.stringify({ to: args.to }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["orphan-drafts"] }),
  });
}

// Tenant OIDC (members' SSO) — the CONNECTION TEST. #589 retired this surface's read and write hooks
// with the single-OIDC form they served: that form wrote whatever `ORDER BY sort, id LIMIT 1`
// returned, so it could only ever edit the first connection. Editing goes through
// PATCH /admin/connections/:id now, per row.
//
// The TEST endpoint stays, and is the reason the legacy routes are not simply gone: it is the
// product's only connection-test path (there is no equivalent under /admin/connections), and the
// row's Test button calls it. Retiring GET/PATCH /admin/oidc server-side is a separate step (#572).
export function useTestTenantOidc() {
  const { token } = useSession();
  return useMutation({
    mutationFn: (issuer: string) => apiFetch<{ ok: boolean; error: string | null }>("/admin/oidc/test", token, { method: "POST", body: JSON.stringify({ issuer }) }),
  });
}

// #537 / ADR-195 §5: tenant SAML SP settings (EE — the routes live in packages/ee-server). The cert
// is write-only (hasCert only). Three server answers, three UI states (samlSectionState in
// AdminSamlSection): 200 → the form; 403+upgrade → UpgradeNotice (ADR-072 admin surface, NOT 404);
// 404 → the route is not mounted at all (CE build) → the section renders nothing.
export interface TenantSamlDTO {
  idpEntityId: string; ssoUrl: string; spEntityId: string; acsUrl: string
  attrEmail: string | null; attrName: string | null; attrGroups: string | null
  enabled: boolean; hasCert: boolean
}
export interface TenantSamlInput {
  idpEntityId: string; ssoUrl: string; idpCert?: string | null
  spEntityId: string; acsUrl: string
  attrEmail?: string | null; attrName?: string | null; attrGroups?: string | null; enabled: boolean
}
// `enabled` lets a caller that KNOWS it may not read this (the server said so) skip the request
// rather than fire a 403 it would have to swallow — #604-B: the sign-in screen now also
// opens to a connection manager, for whom these admin-tier reads are refusals by design.
export function useTenantSaml(enabled = true) {
  const { token } = useSession();
  return useQuery({
    enabled,
    queryKey: ["tenant-saml"],
    queryFn: () => apiFetch<TenantSamlDTO | null>("/admin/saml", token),
    staleTime: 30_000,
    retry: false, // 403/404 are stable answers, not transient failures
  });
}
// #604 / ADR-208 (ruling B): which admin surfaces THIS member may enter. The server walks its
// surface→relation registry and answers; the client never infers a surface from a tier flag or a
// hand-kept verb list, so a verb added server-side reaches the menu and the tabs with no client edit.
// Any member may ask (it describes only your own powers); an empty list means no console at all.
export function useAdminSurfaces() {
  const { token, status } = useSession();
  return useQuery({
    queryKey: ["admin-surfaces"],
    queryFn: () => apiFetch<{ surfaces: string[] }>("/admin/surfaces", token).then((r) => r?.surfaces ?? []),
    enabled: status === "authed",
    staleTime: 60_000,
    retry: false,
  });
}

// #537 Slice 3: the admin's login-methods view + the platform-login toggle (ruling 4).
export interface LoginMethodState { inCeiling: boolean; configured: boolean; selected: boolean; effective: boolean; blockedByStance?: boolean }
export interface LoginMethodsDTO {
  // #568: `local` is password sign-in. It has nothing to configure, so `configured` is always true
  // and the tenant's switch is the whole story.
  methods: {
    "tenant-oidc": LoginMethodState; "platform-oidc": LoginMethodState
    saml: LoginMethodState & { entitled: boolean }; local: LoginMethodState
  }
  // #605 / ADR-210: the SSO-required stance. selected && !biting is the LAPSE — shown, never silent.
  ssoRequired: { selected: boolean; biting: boolean }
  // #652 / ADR-219 §4: the second-factor stance. `canEnable` (an admin has enrolled) and `entitled`
  // (the edition) arrive apart because they are different sentences to read: one is "nobody could
  // satisfy this yet", the other "your plan does not include it". A screen that collapsed them into
  // one greyed switch would tell a tenant to upgrade when the fix is to enrol a factor.
  // `stance` (#676) is which kinds are accepted: "off" | "any" | "passkey" | "totp". `selected` stays
  // as "is anything required" — the switch #652 drew — and the picker that reads `stance` is #679.
  // #672 (review rejection): `stanceRefusals` is the server's own reason each kind-stance cannot be
  // written right now — the same answer its PATCH would give — so the picker can stop offering a choice
  // that only ever 409s, and say which requirement is unmet.
  secondFactorRequired?: {
    selected: boolean; canEnable: boolean; entitled: boolean; stance?: FactorStance
    stanceRefusals?: Partial<Record<"any" | "passkey" | "totp", string | null>>
    // #685: how many admin factors each stance needs, from the server's own `floorFor`. The sentence
    // for an unmet floor interpolates this rather than spelling the figure out in each locale, so the
    // day the ruling changes the screen follows the constant instead of waiting to be found.
    stanceFloors?: Partial<Record<"any" | "passkey" | "totp", number>>
  }
  // #604-B: whether the CALLER may write the stance / platform / password selections and the
  // SSO exemptions. The read opened to `manage_connections`; those writes stayed on the admin tier,
  // so the server names the line instead of the screen inferring it from a tier flag.
  canManageStance?: boolean
}
export function useLoginMethods() {
  const { token } = useSession();
  return useQuery({
    queryKey: ["login-methods-admin"],
    queryFn: () => apiFetch<LoginMethodsDTO>("/admin/login-methods", token),
    staleTime: 30_000,
    retry: false,
  });
}
export function useUpdatePlatformLogin() {
  const { token } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (platformLoginEnabled: boolean) =>
      apiFetch<null>("/admin/login-methods", token, { method: "PATCH", body: JSON.stringify({ platformLoginEnabled }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["login-methods-admin"] }),
  });
}

// #568 / ADR-198 §3: the local switch. Its own hook rather than a parameter on the platform one —
// they are different decisions, and the server refuses to close the last door in either case.
// #605 / ADR-210: the stance switch and its exemptions.
export type FactorStance = "off" | "any" | "passkey" | "totp";

/** #679: what a stance would cost, asked before writing it. */
export function useStanceImpact(kinds: FactorStance | null) {
  const { token } = useSession();
  return useQuery({
    enabled: kinds !== null && kinds !== "off",
    queryKey: ["login-methods-impact", kinds],
    queryFn: () => apiFetch<{ unsatisfied: number; signedOut: number }>(
      `/admin/login-methods/impact?kinds=${encodeURIComponent(kinds!)}`, token),
    staleTime: 0, // the answer is about right now, and the question is asked at the moment of deciding
    retry: false,
  });
}
export function useUpdateSecondFactorStance() {
  const { token } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (secondFactorKinds: FactorStance) =>
      apiFetch<null>("/admin/login-methods", token, { method: "PATCH", body: JSON.stringify({ secondFactorKinds }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["login-methods-admin"] }),
  });
}
export interface SsoExemptionDTO { memberSub: string; createdAt: string; hasCredential: boolean }
export function useUpdateSsoRequired() {
  const { token } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ssoRequired: boolean) =>
      apiFetch<null>("/admin/login-methods", token, { method: "PATCH", body: JSON.stringify({ ssoRequired }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["login-methods-admin"] }),
  });
}
// #652 / ADR-219 §4: the second-factor stance rides the same PATCH as the others (one switchboard),
// and gets its own hook for the same reason `useUpdateSsoRequired` has one: a different decision, with
// its own refusals to report (`admin_factor_required`, `mfa_policy_not_entitled`).
export function useUpdateSecondFactorRequired() {
  const { token } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (secondFactorRequired: boolean) =>
      apiFetch<null>("/admin/login-methods", token, { method: "PATCH", body: JSON.stringify({ secondFactorRequired }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["login-methods-admin"] }),
  });
}
export function useSsoExemptions(enabled = true) {
  const { token } = useSession();
  return useQuery({
    enabled,
    queryKey: ["sso-exemptions"],
    // #623: paged. The admin section is where an exemption is taken away, so a short list is an
    // exemption nobody knows to remove — it walks.
    queryFn: () =>
      walkPages(
        (c: string | null) =>
          apiFetch<{ exemptions: SsoExemptionDTO[]; nextCursor: string | null }>(
            `/admin/sso-exemptions${cursorQuery(c)}`, token),
        (p: { exemptions: SsoExemptionDTO[] }) => p.exemptions,
      ),
  });
}
export function useGrantSsoExemption() {
  const { token } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (sub: string) => apiFetch<null>(`/admin/sso-exemptions/${encodeURIComponent(sub)}`, token, { method: "PUT" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sso-exemptions"] }),
  });
}
export function useRevokeSsoExemption() {
  const { token } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (sub: string) => apiFetch<null>(`/admin/sso-exemptions/${encodeURIComponent(sub)}`, token, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sso-exemptions"] }),
  });
}
export function useUpdateLocalLogin() {
  const { token } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (localLoginEnabled: boolean) =>
      apiFetch<null>("/admin/login-methods", token, { method: "PATCH", body: JSON.stringify({ localLoginEnabled }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["login-methods-admin"] }),
  });
}

export function useUpdateTenantSaml() {
  const { token } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: TenantSamlInput) => apiFetch<null>("/admin/saml", token, { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tenant-saml"] }),
  });
}

// #101 / ADR-034: OIDC enrolment config — which successful logins auto-enrol (policy), the allow-listed
// groups, and the DNS-verified enrol domains (add → publish TXT → verify). tenant#admin gated server-side.
export interface EnrollDomainDTO { domain: string; verified: boolean; challengeRecord: string; challengeValue: string }
export interface EnrollmentDTO { policy: string; policies: string[]; allowedGroups: string[]; verifiedDomains: string[]; domains: EnrollDomainDTO[] }
export function useEnrollment() {
  const { token } = useSession();
  return useQuery({ queryKey: ["enrollment"], queryFn: () => apiFetch<EnrollmentDTO>("/admin/enrollment", token), staleTime: 30_000 });
}
export function useSetEnrollPolicy() {
  const { token } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { policy: string; allowedGroups: string[] }) => apiFetch<null>("/admin/enrollment", token, { method: "PUT", body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["enrollment"] }),
  });
}
export function useAddEnrollDomain() {
  const { token } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (domain: string) => apiFetch<EnrollDomainDTO>("/admin/enrollment/domains", token, { method: "POST", body: JSON.stringify({ domain }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["enrollment"] }),
  });
}
export function useVerifyEnrollDomain() {
  const { token } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (domain: string) => apiFetch<null>(`/admin/enrollment/domains/${encodeURIComponent(domain)}/verify`, token, { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["enrollment"] }),
  });
}
export function useRemoveEnrollDomain() {
  const { token } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (domain: string) => apiFetch<null>(`/admin/enrollment/domains/${encodeURIComponent(domain)}`, token, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["enrollment"] }),
  });
}

// Pages overview for a space (Phase 5 #5) — space#manage only.
export interface PageOverview { id: string; title: string; published: boolean; hasUnpublishedChanges: boolean; grantCount: number; linkCount: number }
export interface PageOverviewPage { items: PageOverview[]; nextCursor: string | null }
/**
 * #623: a page of the space's pages, plus the search that goes with it.
 *
 * The search term is part of the QUERY, not a filter applied after: with the server paging, filtering
 * here would answer "among the ones already fetched", which reads the same and is not the same question.
 */
export function useSpacePagesOverview(spaceId: string, enabled = true, q = "") {
  const { token } = useSession();
  return useInfiniteQuery({
    queryKey: ["pages-overview", spaceId, q],
    initialPageParam: null as string | null,
    getNextPageParam: (last: PageOverviewPage) => last.nextCursor,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams();
      if (pageParam) params.set("cursor", pageParam as string);
      if (q.trim()) params.set("q", q.trim());
      const qs = params.toString();
      return apiFetch<PageOverviewPage>(
        `/spaces/${encodeURIComponent(spaceId)}/pages-overview${qs ? `?${qs}` : ""}`, token,
      ).then((r) => r ?? { items: [], nextCursor: null });
    },
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

// #420 the tenant-wide member typeahead for the admin roles console. Reuses the existing
// admin-only /members listing (same tenant-admin gate as the console itself — no new surface) and
// filters client-side, so assigning a role means picking a person by name instead of pasting a sub.
export function useTenantMemberCandidates(q: string, enabled = true) {
  const { token } = useSession();
  const all = useQuery({
    enabled,
    queryKey: ["tenant-members"],
    queryFn: () => apiFetch<{ members: { sub: string; display_name: string | null; email: string | null }[] }>("/members", token).then((r) => r?.members ?? []),
    staleTime: 30_000,
    retry: false,
  });
  const needle = q.trim().toLowerCase();
  const matches = !needle ? [] : (all.data ?? [])
    .filter((m) => (m.display_name ?? "").toLowerCase().includes(needle) || m.sub.toLowerCase().includes(needle) || (m.email ?? "").toLowerCase().includes(needle))
    .slice(0, 10)
    .map((m) => ({ sub: m.sub, displayName: m.display_name }));
  return { candidates: matches, isError: all.isError };
}

// #617 ②(a): sub → display name, for the admin surfaces that must NAME a member they already hold the
// sub for (an exemption row, a revoke confirmation). Same query key as the typeahead above, so this
// costs no extra request — it reads the list that is already in cache and shapes it as a lookup.
export function useTenantMemberNames(enabled = true): Map<string, string> {
  const { token } = useSession();
  const all = useQuery({
    enabled,
    queryKey: ["tenant-members"],
    queryFn: () => apiFetch<{ members: { sub: string; display_name: string | null; email: string | null }[] }>("/members", token).then((r) => r?.members ?? []),
    staleTime: 30_000,
    retry: false,
  });
  // email is the second-best name: a member invited but never signed in has no display_name yet, and
  // their address is still a human-readable handle where the sub is not.
  return new Map((all.data ?? []).map((m) => [m.sub, m.display_name || m.email || ""]).filter(([, n]) => n !== "") as [string, string][]);
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

// #416 / ADR-161: the page-scoped member typeahead (permissions dialog). page#manage-gated server-side.
export function usePageMemberCandidates(pageId: string | null, q: string) {
  const { token } = useSession();
  return useQuery({
    queryKey: ["page-member-candidates", pageId, q],
    queryFn: () => apiFetch<MemberCandidate[]>(`/pages/${encodeURIComponent(pageId!)}/member-candidates?q=${encodeURIComponent(q)}`, token).then((r) => r ?? []),
    enabled: pageId != null && pageId.length > 0 && q.trim().length > 0,
    staleTime: 10_000,
  });
}

// #449 / ADR-173 addendum: the guest search-preview's ONLY page read — `GET /pages/:id/published`
// with the GUEST token (config.guest:'view', share_link-principal FGA view + non_expired context,
// uniform 404 on deny). Never the member meta route (`GET /pages/:id`), which a guest token cannot
// call — that constraint is why the preview was v1-OFF before the ruling withdrew it. Minimal
// fields by design (#318): title + published body, no creator/member data. Keyed separately from
// the member "published" cache (whose invalidation paths must not sweep guest entries), with the
// token folded in so two links open in one browser never share entries.
export function useGuestPublished(pageId: string, guestToken: string) {
  return useQuery({
    queryKey: ["guest-published", guestToken, pageId],
    queryFn: () => apiFetch<{ title: string; publishedMd: string | null }>(`/pages/${encodeURIComponent(pageId)}/published`, guestToken),
    enabled: pageId.length > 0 && guestToken.length > 0,
    staleTime: 30_000,
  });
}

// #449 / ADR-173: a guest space-link surface passes its own token here; the server forces the guest's
// scope and gates every hit on the share_link principal (stage 2), so the client stays a thin caller.
// The token is folded into the query key so a member's and a guest's result caches never collide.
export function useSearch(q: string, tokenOverride?: string) {
  const { token: sessionToken } = useSession();
  const token = tokenOverride ?? sessionToken;
  const query = q.trim();
  return useQuery({
    queryKey: ["search", tokenOverride ? "guest" : "member", query],
    queryFn: () => apiFetch<SearchHit[]>(`/search?q=${encodeURIComponent(query)}`, token).then((r) => r ?? []),
    enabled: query.length > 0,
    staleTime: 10_000,
    // #366 keep the previous query's hits while the next query loads, so the list never drops to [] for a
    // frame (which let the raw-id fallback steal the picker's selection). Smooths the search modal too.
    placeholderData: keepPreviousData,
  });
}

// #554 S4 / ADR-197 §1-3: the admin connection-management surface (N oidc connections). Secrets are
// write-only (hasSecret). subjectPrefix is display-only (immutable — set at creation, §5).
export interface AdminConnectionDTO {
  id: string; kind: "oidc"; issuer: string; clientId: string; hasSecret: boolean; scopes: string
  redirectUri: string; enabled: boolean; sort: number; label: string | null; preset: string | null
  trustGroups: boolean; subjectPrefix: string | null; groupsClaim: string | null
  // #592 / ADR-204: may this connection's members reach MCP. `mcpEnforceable` is false for a
  // connection that does not namespace its subs (the pre-#570 legacy row): the MCP entry recognises a
  // connection by the prefix on a member's sub, so there the switch would promise a refusal the server
  // cannot make. The row shows it as unavailable rather than lying.
  mcpEnabled: boolean; mcpEnforceable: boolean
}
export interface AdminConnectionInput {
  preset?: string; issuer?: string; clientId?: string; clientSecret?: string | null; redirectUri?: string
  scopes?: string; label?: string; entraTenantId?: string; enabled?: boolean
  trustGroups?: boolean; groupsClaim?: string | null; mcpEnabled?: boolean
}
export function useAdminConnections() {
  const { token } = useSession();
  return useQuery({
    queryKey: ["admin-connections"],
    queryFn: () => apiFetch<AdminConnectionDTO[]>("/admin/connections", token).then((r) => r ?? []),
    staleTime: 30_000,
  });
}
export function useCreateConnection() {
  const { token } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: AdminConnectionInput) => apiFetch<{ id: string }>("/admin/connections", token, { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-connections"] }),
  });
}
export function useUpdateConnection() {
  const { token } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: AdminConnectionInput & { id: string }) =>
      apiFetch<null>(`/admin/connections/${encodeURIComponent(id)}`, token, { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-connections"] }),
  });
}
export function useDeleteConnection() {
  const { token } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<null>(`/admin/connections/${encodeURIComponent(id)}`, token, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-connections"] }),
  });
}
export function useReorderConnections() {
  const { token } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ids: string[]) => apiFetch<null>("/admin/connections/reorder", token, { method: "POST", body: JSON.stringify({ ids }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-connections"] }),
  });
}

// ── second factors (#653 / ADR-219) ──────────────────────────────────────────────────────────────
// Self-scope, like the rest of /me: the server keys everything to the session's own subject, so no id
// of another member is addressable from here.
type PublicKeyCredentialRequestOptionsJSON = Record<string, unknown>;

export interface MemberFactor {
  id: string;
  kind: "totp" | "passkey";
  label: string;
  createdAt: string;
  confirmedAt: string | null;
  lastUsedAt: string | null;
  /**
   * #679: does this factor satisfy the workspace's current requirement? Answered by the SERVER, because
   * it needs the tenant's stance and the host both — a passkey made before a domain move is a row that
   * cannot be presented — and re-deriving it here would be a second place holding the same rule.
   */
  counts?: boolean;
}
export function useMyFactors() {
  const { token } = useSession();
  return useQuery({
    queryKey: ["me", "factors"],
    queryFn: () => apiFetch<{ factors: MemberFactor[]; stance?: string }>("/me/factors", token)
      .then((r) => r?.factors ?? []),
  });
}
/** Begin an enrolment. The secret comes back ONCE, in this response — there is no way to ask again. */
export function useStartTotpEnrolment() {
  const { token } = useSession();
  return useMutation({
    mutationFn: (args: { label?: string }) =>
      apiFetch<{ factorId: string; secret: string; uri: string }>("/me/factors/totp", token, {
        method: "POST", body: JSON.stringify(args),
      }),
  });
}
export function useConfirmFactor() {
  const { token } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { factorId: string; code: string }) =>
      apiFetch<{ confirmed: boolean }>(`/me/factors/${encodeURIComponent(args.factorId)}/confirm`, token, {
        method: "POST", body: JSON.stringify({ code: args.code }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["me", "factors"] }),
  });
}
/**
 * #663 / #666: enrol a PASSKEY. Two calls, because a WebAuthn registration is two halves with the
 * browser's own prompt between them — the server issues options and banks a challenge, the key answers,
 * and the answer comes back to be checked and stored.
 *
 * The endpoints shipped with #663 and nothing called them: the panel offered "add an authenticator app"
 * and no way to add a key, which made #666's removal unreachable from the product for a member who had
 * never been given a way to register one.
 */
export function useStartPasskeyEnrolment() {
  const { token } = useSession();
  return useMutation({
    mutationFn: (args: { label?: string }) =>
      apiFetch<{ factorId: string; options: Record<string, unknown> }>("/me/factors/passkey", token, {
        method: "POST", body: JSON.stringify(args),
      }),
  });
}
export function useConfirmPasskey() {
  const { token } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { factorId: string; response: unknown }) =>
      apiFetch<{ confirmed: boolean }>(`/me/factors/${encodeURIComponent(args.factorId)}/passkey`, token, {
        method: "POST", body: JSON.stringify({ response: args.response }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["me", "factors"] }),
  });
}
/** #666: the challenge for proving possession of the PASSKEY being given up. */
export function useRemovePasskeyChallenge() {
  const { token } = useSession();
  return useMutation({
    mutationFn: (factorId: string) =>
      apiFetch<{ options: PublicKeyCredentialRequestOptionsJSON }>(
        `/me/factors/${encodeURIComponent(factorId)}/remove-challenge`, token, { method: "POST", body: "{}" }),
  });
}

/**
 * #653 ④: rename one. NO code, unlike removal — #660 asks for possession before taking a door
 * away, and a label touches no secret and grants nothing. Requiring the device to fix a typo would
 * just leave the wrong name in place.
 */
export function useRenameFactor() {
  const { token } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { factorId: string; label: string }) =>
      apiFetch<void>(`/me/factors/${encodeURIComponent(args.factorId)}`, token, {
        method: "PATCH", body: JSON.stringify({ label: args.label }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["me", "factors"] }),
  });
}

/** #660: removing one needs a current code FROM it — possession, not a password (ADR-219 §8). */
export function useRemoveFactor() {
  const { token } = useSession();
  const qc = useQueryClient();
  return useMutation({
    // #666: a passkey proves itself with an assertion, a TOTP with a code — the proof belongs to the
    // FACTOR. One kind must not authorise the other's removal, or taking one lets somebody strip both.
    mutationFn: (args: { factorId: string; code?: string; passkey?: unknown }) =>
      apiFetch<void>(
        `/me/factors/${encodeURIComponent(args.factorId)}${
          args.passkey ? `?passkey=${encodeURIComponent(JSON.stringify(args.passkey))}`
          : args.code ? `?code=${encodeURIComponent(args.code)}` : ""}`,
        token, { method: "DELETE" },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["me", "factors"] }),
  });
}
