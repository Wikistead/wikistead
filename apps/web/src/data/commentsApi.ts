// Comments data layer (P4). Thin wrappers over apiFetch. The two-stage authz +
// no-leak (read=view, write=comment) lives server-side; the client only renders
// what it's allowed to see. A page the user can't view returns 404 → the panel
// shows nothing.
import { apiFetch, ApiError } from "./apiClient";

export interface CommentItem {
  id: string;
  body: string;
  authorSub: string;
  createdAt: string;
  editedAt: string | null;
  canModify: boolean; // #100: server-computed — this principal (author or admin) may delete/edit it
}
export interface CommentThread {
  id: string;
  kind: "page" | "inline";
  status: "open" | "resolved";
  quotedText: string | null;
  anchorStart: string | null; // base64 encoded Yjs RelativePosition
  anchorEnd: string | null;
  createdBy: string;
  createdAt: string;
  resolvedBy: string | null;
  resolvedAt: string | null;
  comments: CommentItem[];
}
export interface Mentionable {
  sub: string;
  displayName: string | null;
}

export async function listComments(token: string, pageId: string): Promise<CommentThread[] | null> {
  try {
    const r = await apiFetch<{ threads: CommentThread[] }>(`/pages/${encodeURIComponent(pageId)}/comments`, token);
    return r?.threads ?? [];
  } catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.status === 403)) return null; // not viewable
    throw e;
  }
}

export interface NewThread {
  body: string;
  kind?: "page" | "inline";
  anchorStart?: string;
  anchorEnd?: string;
  quotedText?: string;
  mentions?: string[];
}
export async function createThread(token: string, pageId: string, t: NewThread): Promise<{ threadId: string }> {
  return (await apiFetch<{ threadId: string }>(`/pages/${encodeURIComponent(pageId)}/comments`, token, {
    method: "POST",
    body: JSON.stringify(t),
  }))!;
}
export async function replyToThread(token: string, threadId: string, body: string, mentions?: string[]): Promise<void> {
  await apiFetch(`/comments/threads/${encodeURIComponent(threadId)}/comments`, token, { method: "POST", body: JSON.stringify({ body, mentions }) });
}
export async function setThreadStatus(token: string, threadId: string, action: "resolve" | "reopen"): Promise<void> {
  await apiFetch(`/comments/threads/${encodeURIComponent(threadId)}/${action}`, token, { method: "POST" });
}
export async function deleteComment(token: string, commentId: string): Promise<void> {
  await apiFetch(`/comments/${encodeURIComponent(commentId)}`, token, { method: "DELETE" });
}
export async function fetchMentionable(token: string, pageId: string): Promise<Mentionable[]> {
  const r = await apiFetch<{ members: Mentionable[] }>(`/pages/${encodeURIComponent(pageId)}/mentionable`, token).catch(() => null);
  return r?.members ?? [];
}
