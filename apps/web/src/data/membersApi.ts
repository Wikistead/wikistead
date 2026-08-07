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
  /** #644: a CONFIRMED second factor exists (existence only, like `has_password`). The console reads it
   *  so it does not offer a reset to somebody holding nothing — that call succeeds with a count of zero,
   *  which reports having done something. */
  has_factor?: boolean;
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
  /** #638: when this invitation was last mailed, or null if it has only ever existed on screen.
   *  Sending is best-effort, so "invited" and "reached" are different facts and the list says which. */
  last_emailed_at?: string | null;
}

/** #623: one page of members, plus the cursor for the next. `q` is a SERVER query — see MembersPage. */
export async function listMembers(
  token: string, opts: { cursor?: string | null; q?: string } = {},
): Promise<{ members: Member[]; nextCursor: string | null }> {
  const params = new URLSearchParams();
  if (opts.cursor) params.set("cursor", opts.cursor);
  if (opts.q?.trim()) params.set("q", opts.q.trim());
  const qs = params.toString();
  const r = await apiFetch<{ members: Member[]; nextCursor: string | null }>(`/members${qs ? `?${qs}` : ""}`, token);
  return { members: r?.members ?? [], nextCursor: r?.nextCursor ?? null };
}
/** #623: the invitation list is paged now. The screen keeps the whole set — an invitation nobody can
 *  see is one nobody can revoke or re-issue, and #638 put the controls on each row. */
export async function listInvites(token: string): Promise<Invite[]> {
  const all: Invite[] = [];
  let cursor: string | null = null;
  // the loop condition is the CURSOR, never "the page came back empty"
  do {
    const q: string = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
    const r: { invites: Invite[]; nextCursor: string | null } | null =
      await apiFetch(`/members/invites${q}`, token);
    if (!r) break;
    all.push(...(r.invites ?? []));
    cursor = r.nextCursor ?? null;
  } while (cursor);
  return all;
}
export async function createInvite(token: string, body: { email: string; role: "admin" | "member"; roleId?: string | null }): Promise<{ inviteUrl: string; emailed: boolean }> {
  return (await apiFetch<{ inviteUrl: string; emailed: boolean }>("/members/invites", token, { method: "POST", body: JSON.stringify(body) }))!;
}
/** #638: hand a pending invitation over again.
 *
 *  A RE-ISSUE, not a re-display: the token is stored hashed, so nothing can show the old link again. The
 *  previous one stops working, which is why the response says so and the screen has to repeat it. Passing
 *  `email` also mails the new link — the same act, a second delivery, and the link still comes back
 *  because sending is best-effort and an admin whose mail fails silently still needs their copy. */
export async function reissueInvite(token: string, id: string, opts: { email?: boolean } = {}): Promise<{ inviteUrl: string; emailed: boolean; previousLinkRevoked: boolean }> {
  return (await apiFetch<{ inviteUrl: string; emailed: boolean; previousLinkRevoked: boolean }>(
    `/members/invites/${encodeURIComponent(id)}/reissue`, token,
    { method: "POST", body: JSON.stringify({ email: opts.email === true }) },
  ))!;
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

/**
 * #644ruling 2 / ADR-219 §4: clear a member's second factors so they can enrol again.
 *
 * The only way back for somebody whose factor was on a device they no longer have. It HANDS NOTHING
 * BACK — no link, no token — because a recovery URL minted for a second factor would be a way past the
 * second factor, which is what ADR-210 §2(b) refused. The member signs in the ordinary way and meets
 * the enrolment step (#652).
 */
export async function resetFactors(token: string, sub: string): Promise<number> {
  const res = await apiFetch<{ removed: number } | null>(
    `/members/${encodeURIComponent(sub)}/factors`, token, { method: "DELETE" });
  return res?.removed ?? 0;
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
