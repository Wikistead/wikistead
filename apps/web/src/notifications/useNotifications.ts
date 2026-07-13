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
  title: string | null;
  createdAt: string;
  notificationId?: string;
  read?: boolean;
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

export function useWatchState(pageId: string | undefined) {
  const { token } = useSession();
  return useQuery({
    queryKey: ["watch", "page", pageId],
    queryFn: () => apiFetch<WatchState>(`/watches?resourceType=page&resourceId=${encodeURIComponent(pageId!)}`, token),
    enabled: !!pageId,
  });
}

// Toggle a page watch. Optimistic-free (cheap round-trip); invalidates the watch state on success.
export function useToggleWatch(pageId: string | undefined) {
  const { token } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (current: WatchState | null | undefined) => {
      if (current?.watching && current.id) {
        await apiFetch(`/watches/${current.id}`, token, { method: "DELETE" });
      } else if (pageId) {
        await apiFetch("/watches", token, { method: "POST", body: JSON.stringify({ resourceType: "page", resourceId: pageId }) });
      }
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["watch", "page", pageId] }),
  });
}
