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
}
export interface Page {
  id: string;
  spaceId: string;
  parentId: string | null;
  title: string;
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

export function useCreatePage() {
  const { token } = useSession();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { spaceId: string; title: string }) =>
      apiFetch<Page>(`/spaces/${args.spaceId}/pages`, token, {
        method: "POST",
        body: JSON.stringify({ title: args.title }),
      }),
    onSuccess: (_p, args) => qc.invalidateQueries({ queryKey: ["pages", args.spaceId] }),
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
