import { useMutation, useQuery, useQueryClient, keepPreviousData } from "@tanstack/react-query";
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
    queryFn: () => apiFetch<Space[]>("/spaces", token).then((r) =>
      (r ?? []).map((s) => ({ ...s, iconImageUrl: s.iconImageUrl ? assetUrl(s.iconImageUrl) : null })),
    ),
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

// #445the caller's own capabilities. Read to HIDE an affordance the server would refuse;
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
    onSuccess: (_p, args) => qc.invalidateQueries({ queryKey: ["pages", args.spaceId] }),
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

export function useShareLinks(resource: ShareResource | null, enabled = true) {
  const { token } = useSession();
  return useQuery({
    queryKey: ["share-links", resource?.type, resource?.id],
    queryFn: () => apiFetch<ShareLink[]>(linksPath(resource!), token).then((r) => r ?? []),
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
    // #361the poll PAUSES while a checkbox toggle is in flight — a poll landing between two
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
  editorKeymap: "default" | "vim" | "local"; // startup-mode preference (keymap)
  editorDisplayMode: "live" | "source" | "wysiwyg" | "local"; // startup display mode (ADR-056 / #164 · #289 wysiwyg)
  keybindings: Record<string, string>; // commandId → chord override (ADR-021); {} = defaults
  hasAvatar: boolean;
  editorChrome: EditorChromeVisibility | null; // #289: visibility only (startup mode stays above)
  onboardingCompletedAt: string | null; // #289: null → the first-run two-question flow fires once
  notificationsEnabled: boolean; // #362: global notification kill switch (emission-narrowing only)
  defaultEventMask: string[]; // #362: default event mask for mask-less watches ([] = all types)
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
  // #431the caller's OWN sub resolves from the session, which already holds the canonical
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
  // #431same self-resolution as the single form, so a list surface (history) labels the
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
export interface ActivityDay { day: string; count: number; edits: number; comments: number } // #483per-kind split for the tooltip
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
    mutationFn: (body: { displayNameOverride?: string | null; editorKeymap?: "default" | "vim" | "local"; editorDisplayMode?: "live" | "source" | "wysiwyg" | "local"; keybindings?: Record<string, string>; editorChrome?: EditorChromeVisibility | null; onboardingCompleted?: boolean; notificationsEnabled?: boolean; defaultEventMask?: string[] }) =>
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

// #361per-page SERIAL chain for task toggles. The server's no-revision fold guard demands the
// draft differ from published by EXACTLY the one claimed flip — so a rapid burst must not pile a second
// draft flip in before the first fold commits (that 409'd every request on a clean page as "publish
// first"). Each toggle's draft write (`applyFlip`) AND its POST run as one chained unit, strictly after
// the previous toggle settled: every fold sees exactly one flip, and every burst click lands in order.
// The chain lives OUTSIDE the mutation so the mutation itself still starts at click time — which is what
// keeps therefetch coalescing (isMutating counts the whole burst) and thepoll gate honest.
// #361(P0 ruling: "the animation must start on the click frame; a burst 409 is acceptable if
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
    // #361rapid toggles must COALESCE their refetches. Each click fires its own POST; if every
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
    // #361the SIDEBAR ring is the one progress surface not derived from a document — it reads
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

export function usePageRevisions(pageId: string, enabled = true) {
  const { token } = useSession();
  return useQuery({
    queryKey: ["revisions", pageId],
    queryFn: () => apiFetch<Revision[]>(`/pages/${encodeURIComponent(pageId)}/revisions`, token).then((r) => r ?? []),
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
export interface PageGrant { grantee: string; relation: PageRelation; groupName?: string }

export function usePageAccess(pageId: string, enabled = true) {
  const { token } = useSession();
  return useQuery({
    queryKey: ["page-access", pageId],
    queryFn: () => apiFetch<PageGrant[]>(`/pages/${encodeURIComponent(pageId)}/access`, token).then((r) => r ?? []),
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
      apiFetch<null>(`/pages/${encodeURIComponent(pageId)}/access`, token, { method: "DELETE", body: JSON.stringify(args) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["page-access", pageId] }),
  });
}

// #109 / ADR-072 monotonic deny — the per-page restriction (deny) list, distinct from grants. A
// restricted principal 404s on the page even as a space viewer.
export interface PageRestriction { principal: string }
export function usePageRestrictions(pageId: string, enabled = true) {
  const { token } = useSession();
  return useQuery({
    queryKey: ["page-restrict", pageId],
    queryFn: () => apiFetch<PageRestriction[]>(`/pages/${encodeURIComponent(pageId)}/restrict`, token).then((r) => r ?? []),
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
export function useTenantGroups(spaceId: string, enabled = true) {
  const { token } = useSession();
  return useQuery({
    queryKey: ["tenant-groups", spaceId],
    queryFn: () => apiFetch<string[]>(`/spaces/${encodeURIComponent(spaceId)}/groups`, token).then((r) => r ?? []),
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
export interface SpaceGrant { grantee: string; capability: PageRelation; groupName?: string }
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
    // The API body keys the capability as `relation` (shared page/space vocabulary). grantee OR
    // groupName (#163: server resolves the group name → group:<id>#member).
    mutationFn: (args: { grantee?: string; groupName?: string; capability: PageRelation }) =>
      apiFetch<null>(`/spaces/${encodeURIComponent(spaceId)}/access`, token, { method: "POST", body: JSON.stringify({ grantee: args.grantee, groupName: args.groupName, relation: args.capability }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["space-access", spaceId] }),
  });
}
export function useRevokeSpaceAccess(spaceId: string) {
  const { token } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { grantee?: string; groupName?: string; capability: PageRelation }) =>
      apiFetch<null>(`/spaces/${encodeURIComponent(spaceId)}/access`, token, { method: "DELETE", body: JSON.stringify({ grantee: args.grantee, groupName: args.groupName, relation: args.capability }) }),
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
export interface BrandingDTO { displayName: string | null; accentKey: string | null; logoUrl: string | null; whitelabel?: boolean } // #430: paid = white-label public pages
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
  return useQuery({
    queryKey: ["title-dictionary", pageId],
    enabled: !!pageId,
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
  // #495 / ADR-182: present ONLY on the admin list (GET /api-keys) so an admin can revoke a specific
  // member's key. ownerName follows #486 (null → null, no email fallback). Never a secret.
  ownerUserId?: string; ownerName?: string | null }
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
export interface ApiKeyPolicy { policy: "members" | "admins_only"; canIssue: boolean; maxScope: ApiScope }
export function useMyApiKeyPolicy() {
  const { token } = useSession();
  return useQuery({ queryKey: ["api-keys", "policy"], queryFn: () => apiFetch<ApiKeyPolicy>("/api-keys/policy", token) });
}
export function useCreateApiKey() {
  const { token } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { name: string; scope: ApiScope }) => apiFetch<ApiKeyCreated>("/api-keys", token, { method: "POST", body: JSON.stringify(args) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["api-keys"] }), // refreshes both lists (shared key prefix)
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
export function useRoles(enabled = true) {
  const { token } = useSession();
  return useQuery({
    queryKey: ["roles"],
    queryFn: () => apiFetch<{ builtIn: { name: string; capabilities: string[] }[]; custom: RoleDef[] }>("/admin/roles", token),
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
    // #445the inline capability toggle commits per-op, so the checkbox must MOVE on click —
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
export interface RoleAssignment { id: string; roleId: string; roleName: string; principal: string }
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
    mutationFn: ({ roleId, ...body }: { roleId: string; resourceType: string; resourceId: string; principal: string }) =>
      apiFetch<RoleAssignment>(`/admin/roles/${encodeURIComponent(roleId)}/assignments`, token, { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["role-assignments"] }),
  });
}
export function useUnassignRole() {
  const { token } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (assignmentId: string) => apiFetch<void>(`/admin/roles/assignments/${encodeURIComponent(assignmentId)}`, token, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["role-assignments"] }),
  });
}

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
// member.createSpaces IS the tenant#space_creator wildcard tuple; admin is locked-on by the model.
export interface TenantRoleDefaults { member: { createSpaces: boolean }; admin: { createSpaces: boolean; locked: boolean } }
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
    mutationFn: (memberCreateSpaces: boolean) =>
      apiFetch<TenantRoleDefaults>(`/admin/roles/tenant-defaults`, token, { method: "PUT", body: JSON.stringify({ memberCreateSpaces }) }),
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
  return useQuery({ queryKey: ["webhooks"], queryFn: () => apiFetch<WebhookSummary[]>("/webhooks", token).then((r) => r ?? []) });
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
  return useQuery({ queryKey: ["api-policy"], queryFn: () => apiFetch<{ maxScope: ApiScope; issuePolicy: "members" | "admins_only" }>("/admin/api-policy", token) });
}
// #462: each switch sends only its own field, so the two on this panel cannot overwrite each other
// with a stale copy of the other's value.
export function useUpdateApiPolicy() {
  const { token } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: { maxScope?: ApiScope; issuePolicy?: "members" | "admins_only" }) =>
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

// Tenant OIDC (members' SSO) settings (Phase 5e) — tenant#admin only. The secret is
// never returned (write-only); hasSecret signals whether one is stored.
export interface TenantOidcDTO { issuer: string; clientId: string; scopes: string; redirectUri: string; enabled: boolean; hasSecret: boolean; groupsClaim: string | null }
export interface TenantOidcInput { issuer: string; clientId: string; clientSecret?: string | null; scopes: string; redirectUri: string; enabled: boolean; groupsClaim?: string | null }
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

// #420the tenant-wide member typeahead for the admin roles console. Reuses the existing
// admin-only /members listing (same tenant-admin gate as the console itself — no new surface) and
// filters client-side, so assigning a role means picking a person by name instead of pasting a sub.
export function useTenantMemberCandidates(q: string) {
  const { token } = useSession();
  const all = useQuery({
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
    // #366keep the previous query's hits while the next query loads, so the list never drops to [] for a
    // frame (which let the raw-id fallback steal the picker's selection). Smooths the search modal too.
    placeholderData: keepPreviousData,
  });
}
