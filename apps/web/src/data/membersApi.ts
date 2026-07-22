// Admin Console data layer (P1.4) — typed wrappers over apiFetch for member
// management. Every endpoint is admin-only server-side; a non-admin gets 403,
// which the page surfaces as "admin only". The tenant is resolved from the Host.
import { apiFetch, ApiError } from "./apiClient";

export interface Member {
  sub: string;
  email: string | null;
  display_name: string | null;
  picture_url: string | null;
  role: "admin" | "member";
  created_at: string;
}
export interface Invite {
  id: string;
  email: string | null;
  role: "admin" | "member";
  invited_by: string;
  expires_at: string;
  created_at: string;
}

export async function listMembers(token: string): Promise<Member[]> {
  return (await apiFetch<{ members: Member[] }>("/members", token))?.members ?? [];
}
export async function listInvites(token: string): Promise<Invite[]> {
  return (await apiFetch<{ invites: Invite[] }>("/members/invites", token))?.invites ?? [];
}
export async function createInvite(token: string, body: { email: string; role: "admin" | "member" }): Promise<{ inviteUrl: string; emailed: boolean }> {
  return (await apiFetch<{ inviteUrl: string; emailed: boolean }>("/members/invites", token, { method: "POST", body: JSON.stringify(body) }))!;
}
export async function revokeInvite(token: string, id: string): Promise<void> {
  await apiFetch(`/members/invites/${encodeURIComponent(id)}`, token, { method: "DELETE" });
}
export async function changeRole(token: string, sub: string, role: "admin" | "member"): Promise<void> {
  await apiFetch(`/members/${encodeURIComponent(sub)}`, token, { method: "PATCH", body: JSON.stringify({ role }) });
}
export async function removeMember(token: string, sub: string): Promise<void> {
  await apiFetch(`/members/${encodeURIComponent(sub)}`, token, { method: "DELETE" });
}

// #464 / ADR-175 §6 (DSAR): erase ONE member's page-analytics reading history (the member keeps access).
export async function eraseMemberAnalytics(token: string, sub: string): Promise<void> {
  await apiFetch(`/admin/analytics/member/${encodeURIComponent(sub)}`, token, { method: "DELETE" });
}

export { ApiError };
