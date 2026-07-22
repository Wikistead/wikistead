import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../data/apiClient";
import { useSession } from "../session/SessionProvider";

// #320 / ADR-126: client hooks for the watch / notifications subsystem. All member-only (the server 401s a
// guest); the server view-filters every read, so these never surface a change the caller can't see.

export interface FeedItem {
  id: string;
  eventType: string;
  pageId: string | null;
  spaceId: string | null;
  actor: string;
  actorName?: string | null; // #486 / ADR-150 Addendum 2: server-resolved actor name (view-filtered feed)
  title: string | null;
  createdAt: string;
  notificationId?: string;
  read?: boolean;
  patrolled?: boolean; // #326: the feed (Recent Changes) row's patrol/reviewed state
}

// The bell badge. Cheap raw per-member count (self-corrects when the gated list opens). Polled so a
// notification that lands while the app is open shows up without a manual refresh.
export function useUnreadCount(enabled = true) {
  const { token } = useSession();
  return useQuery({
    queryKey: ["notif-unread"],
    queryFn: () => apiFetch<{ count: number }>("/notifications/unread-count", token).then((r) => r?.count ?? 0),
    enabled,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
}

export function useNotifications(enabled: boolean) {
  const { token } = useSession();
  return useQuery({
    queryKey: ["notif-list"],
    queryFn: () => apiFetch<FeedItem[]>("/notifications", token).then((r) => r ?? []),
    enabled,
  });
}

// #326 / ADR-142: the cross-space Recent Changes activity feed (the /feed endpoint the patrol backend already
// serves). Member-only + server view-filters every event (two-stage FGA gate) — an event about a page the
// member can't see never appears. `unpatrolled` filters to events no moderator has marked reviewed.
export function useFeed(opts: { spaceId?: string; unpatrolled?: boolean; enabled?: boolean } = {}) {
  const { token } = useSession();
  const { spaceId, unpatrolled, enabled = true } = opts;
  return useQuery({
    queryKey: ["feed", spaceId ?? null, !!unpatrolled],
    queryFn: () => {
      const qs = new URLSearchParams();
      if (spaceId) qs.set("spaceId", spaceId);
      if (unpatrolled) qs.set("unpatrolled", "true");
      const suffix = qs.toString() ? `?${qs}` : "";
      return apiFetch<FeedItem[]>(`/feed${suffix}`, token).then((r) => r ?? []);
    },
    enabled,
  });
}

// #326 / ADR-142 Addendum 2: the space PATROL queue — the same feed shape, narrowed server-side to
// the moderation supply (abuse refusals + anonymous/share-link activity) and gated on space#moderate.
// A 403 here means "you do not moderate this space", which the tab renders as a denial rather than an
// empty queue: an empty list and a refused list must not look the same.
export function usePatrolQueue(spaceId: string | undefined, opts: { unpatrolled?: boolean } = {}) {
  const { token } = useSession();
  return useQuery({
    queryKey: ["patrol", spaceId ?? null, !!opts.unpatrolled],
    queryFn: () => {
      const qs = opts.unpatrolled ? "?unpatrolled=true" : "";
      return apiFetch<FeedItem[]>(`/spaces/${encodeURIComponent(spaceId!)}/patrol${qs}`, token).then((r) => r ?? []);
    },
    enabled: !!spaceId,
    retry: false,
  });
}

// #326 / ADR-142 (C-1 patrol): mark / unmark a feed event as reviewed. Member-only; the server enforces the
// per-event view-confirm → uniform 404 → capability gate order (a moderate/manage-gated write). Invalidates
// the feed so the row's patrol state + the unpatrolled filter refresh.
export function useTogglePatrol() {
  const { token } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ eventId, patrolled }: { eventId: string; patrolled: boolean }) =>
      apiFetch(`/feed/${encodeURIComponent(eventId)}/patrol`, token, { method: patrolled ? "DELETE" : "POST" }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["feed"] });
      void qc.invalidateQueries({ queryKey: ["patrol"] }); // #326: the space queue shows the same rows
    },
  });
}

export function useMarkNotificationRead() {
  const { token } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch(`/notifications/${id}/read`, token, { method: "POST" }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["notif-unread"] });
      void qc.invalidateQueries({ queryKey: ["notif-list"] });
    },
  });
}

export interface WatchState { watching: boolean; id: string | null }

// #362: the three watch scopes (page / page+descendants / whole space). Scope narrows EMISSION only —
// the server's display gates are the permission authority regardless.
export type WatchScope = "page" | "subtree" | "space";

// #362: the event types a watch mask can select (mention is a direct address, not a subscription — it
// appears only in the account-level default mask). Kept in sync with the server emitters.
export const WATCH_EVENT_TYPES = [
  "page.published",
  "page.restored",
  "comment.created",
  "attachment.confirmed",
  "page.made_public",
  "page.made_non_public",
] as const;

export function useWatchState(pageId: string | undefined, scope: WatchScope = "page") {
  const { token } = useSession();
  return useQuery({
    queryKey: ["watch", scope, pageId],
    queryFn: () => apiFetch<WatchState>(`/watches?resourceType=${scope}&resourceId=${encodeURIComponent(pageId!)}`, token),
    enabled: !!pageId,
  });
}

// Toggle a watch at a scope. Optimistic-free (cheap round-trip); invalidates the scope's state + the list.
export function useToggleWatch(resourceId: string | undefined, scope: WatchScope = "page") {
  const { token } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (current: WatchState | null | undefined) => {
      if (current?.watching && current.id) {
        await apiFetch(`/watches/${current.id}`, token, { method: "DELETE" });
      } else if (resourceId) {
        await apiFetch("/watches", token, { method: "POST", body: JSON.stringify({ resourceType: scope, resourceId }) });
      }
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["watch", scope, resourceId] });
      void qc.invalidateQueries({ queryKey: ["watches"] });
    },
  });
}

// #362: the member's full watch list (bell → "watching"). Titles are server-resolved and VIEW-FILTERED
// (a no-longer-viewable target comes back title:null — rendered as an inert untitled row).
export interface WatchRow { id: string; resourceType: WatchScope; resourceId: string; eventMask: string[]; muted: boolean; title: string | null }
export function useWatchList(enabled = true) {
  const { token } = useSession();
  return useQuery({
    queryKey: ["watches"],
    queryFn: () => apiFetch<WatchRow[]>("/watches", token).then((r) => r ?? []),
    enabled,
  });
}

// #362: per-watch preferences (mute / event mask) — member-scoped server-side.
export function useUpdateWatch() {
  const { token } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, muted, eventMask }: { id: string; muted?: boolean; eventMask?: string[] }) =>
      apiFetch(`/watches/${encodeURIComponent(id)}`, token, { method: "PATCH", body: JSON.stringify({ muted, eventMask }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["watches"] }),
  });
}

export function useUnwatch() {
  const { token } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch(`/watches/${encodeURIComponent(id)}`, token, { method: "DELETE" }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["watches"] });
      void qc.invalidateQueries({ queryKey: ["watch"] });
    },
  });
}

// #362: badge self-service reset (server touches only the caller's rows).
export function useMarkAllRead() {
  const { token } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch("/notifications/read-all", token, { method: "POST" }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["notif-unread"] });
      void qc.invalidateQueries({ queryKey: ["notif-list"] });
    },
  });
}
