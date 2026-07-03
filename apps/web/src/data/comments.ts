import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSession } from "../session/SessionProvider";
import * as api from "./commentsApi";

// useComments returns null when the page isn't viewable (server 404/403) — the
// panel then renders nothing, so a page the user can't view never shows comments.
// #100 (authz): `tokenOverride` lets the GUEST view pass its guest share token so comment ops run as
// the GUEST — not the app SessionProvider's member/dev token. Without it a guest's delete/edit ran with
// the session token (in dev the dev-user bypass), letting a "guest" delete a member's comment. Members
// omit it → the session token (cookie/dev) is used, unchanged.
export function useComments(pageId: string, tokenOverride?: string) {
  const { token: sessionToken } = useSession();
  const token = tokenOverride ?? sessionToken;
  return useQuery({
    queryKey: ["comments", pageId, token],
    queryFn: () => api.listComments(token, pageId),
    enabled: pageId.length > 0,
    staleTime: 5_000,
  });
}

export function useCommentMutations(pageId: string, tokenOverride?: string) {
  const { token: sessionToken } = useSession();
  const token = tokenOverride ?? sessionToken;
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: ["comments", pageId] });
  return {
    createThread: useMutation({ mutationFn: (t: api.NewThread) => api.createThread(token, pageId, t), onSuccess: invalidate }),
    reply: useMutation({ mutationFn: (a: { threadId: string; body: string; mentions?: string[] }) => api.replyToThread(token, a.threadId, a.body, a.mentions), onSuccess: invalidate }),
    setStatus: useMutation({ mutationFn: (a: { threadId: string; action: "resolve" | "reopen" }) => api.setThreadStatus(token, a.threadId, a.action), onSuccess: invalidate }),
    remove: useMutation({ mutationFn: (commentId: string) => api.deleteComment(token, commentId), onSuccess: invalidate }),
  };
}

// Mention directory is fetched on demand (when the composer needs it), scoped
// server-side to members who can VIEW this page.
export function fetchMentionable(token: string, pageId: string) {
  return api.fetchMentionable(token, pageId);
}
