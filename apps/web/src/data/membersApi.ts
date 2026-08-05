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
  /** ADR-207 rev3 (#603): the group names this member carries — what joins a person to the tier a
   *  group confers on them (the admin-via-group marker). */
  groups?: string[] | null;
  created_at: string;
  /** #614: who minted the identity — an external IdP or this product (a password-born local user). */
  identity_source?: "oidc" | "local";
  /** #614: a password entrance exists (existence only — the credential itself never leaves the server). */
  has_password?: boolean;
  /** #614: SCIM/downgrade freeze timestamp; null/absent = active. The row stays listed either way. */
  deactivated_at?: string | null;
  /** #627: whose suspension this is — only an `admin` one is the console's to undo. */
  deactivation_reason?: "scim" | "admin" | "downgrade_freeze" | null;
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
export async function createInvite(token: string, body: { email: string; role: "admin" | "member"; roleId?: string | null }): Promise<{ inviteUrl: string; emailed: boolean }> {
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

// #606 / ADR-205 §2 (ruled option A): give an existing member a password entrance. Returns the link the
// admin passes on — the member sets the password themselves, and it binds to the sub they already have,
// so nobody is duplicated (which is what sending them a password INVITE used to do).
/** #626 / ADR-214: take the password entrance back. Refusals carry a code the caller can read
 *  (`last_way_in`, `sso_exemption_required`) — they are two different reasons and neither is a failure. */
export async function removePassword(token: string, sub: string): Promise<void> {
  await apiFetch<{ removed: boolean } | null>(`/members/${encodeURIComponent(sub)}/password-setup`, token, { method: "DELETE" });
}

/** #627 / ADR-213: suspend a member (sign-in blocked, grants stripped, keys revoked, sessions ended). */
export async function suspendMember(token: string, sub: string): Promise<void> {
  await apiFetch<{ suspended: boolean } | null>(`/members/${encodeURIComponent(sub)}/suspend`, token, { method: "POST" });
}
/** …and bring them back. Group-derived roles do not return — the directory re-adds those. */
export async function reactivateMember(token: string, sub: string): Promise<void> {
  await apiFetch<{ reactivated: boolean } | null>(`/members/${encodeURIComponent(sub)}/reactivate`, token, { method: "POST" });
}

export async function enablePassword(token: string, sub: string): Promise<{ setupUrl: string; email: string }> {
  const res = await apiFetch<{ setupUrl: string; email: string } | null>(`/members/${encodeURIComponent(sub)}/password-setup`, token, { method: "POST" });
  if (!res) throw new Error("password setup returned nothing");
  return res;
}
