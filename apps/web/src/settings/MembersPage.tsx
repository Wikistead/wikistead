import { useCallback, useEffect, useState } from "react";
import { useSession } from "../session/SessionProvider";
import {
  listMembers, listInvites, createInvite, revokeInvite, changeRole, removeMember,
  ApiError, type Member, type Invite,
} from "../data/membersApi";

// Admin Console: member list (role change / remove) + invites (create / revoke).
// All actions hit admin-only endpoints; a non-admin sees an "admin only" notice
// (the server is the authority — this screen is just chrome).
export function MembersPage() {
  const { token, sub: me } = useSession();
  const [members, setMembers] = useState<Member[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"admin" | "member">("member");
  const [lastLink, setLastLink] = useState<{ url: string; emailed: boolean } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [m, i] = await Promise.all([listMembers(token), listInvites(token)]);
      setMembers(m);
      setInvites(i);
      setForbidden(false);
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) setForbidden(true);
      else setError("Could not load members");
    }
  }, [token]);

  useEffect(() => { void refresh(); }, [refresh]);

  const onInvite = async () => {
    setError(null);
    try {
      const res = await createInvite(token, { email: email.trim(), role });
      setLastLink({ url: res.inviteUrl, emailed: res.emailed });
      setEmail("");
      await refresh();
    } catch (e) {
      setError(e instanceof ApiError && e.status === 403 ? "Seat limit reached — upgrade to invite more members." : "Could not create invite");
    }
  };

  const guarded = (fn: () => Promise<void>) => async () => {
    setError(null);
    try { await fn(); await refresh(); }
    catch (e) { setError(e instanceof ApiError && e.status === 409 ? "Cannot change the last admin." : "Action failed"); }
  };

  if (forbidden) {
    return <div style={{ padding: 24, maxWidth: 560 }}><h2>Members</h2><p style={{ color: "var(--fg-dim)" }}>Admin only.</p></div>;
  }

  return (
    <div style={{ padding: 24, maxWidth: 720 }}>
      <h2 style={{ marginTop: 0 }}>Members</h2>
      {error && <p style={{ color: "crimson" }}>{error}</p>}

      <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: 32 }}>
        <thead>
          <tr style={{ textAlign: "left", borderBottom: "1px solid var(--border, #333)" }}>
            <th style={{ padding: "8px 4px" }}>Member</th><th>Role</th><th></th>
          </tr>
        </thead>
        <tbody>
          {members.map((m) => (
            <tr key={m.sub} style={{ borderBottom: "1px solid var(--border, #222)" }}>
              <td style={{ padding: "8px 4px" }}>{m.display_name || m.email || m.sub}{m.sub === me && " (you)"}</td>
              <td>
                <select aria-label={`role for ${m.sub}`} value={m.role} onChange={(e) => void guarded(() => changeRole(token, m.sub, e.target.value as "admin" | "member"))()}>
                  <option value="member">member</option>
                  <option value="admin">admin</option>
                </select>
              </td>
              <td style={{ textAlign: "right" }}>
                <button type="button" onClick={() => void guarded(() => removeMember(token, m.sub))()}>Remove</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3>Invite a member</h3>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="email@example.com" aria-label="invite email" type="email" />
        <select aria-label="invite role" value={role} onChange={(e) => setRole(e.target.value as "admin" | "member")}>
          <option value="member">member</option>
          <option value="admin">admin</option>
        </select>
        <button type="button" disabled={!email.trim()} onClick={() => void onInvite()}>Send invite</button>
      </div>
      {lastLink && (
        <p style={{ marginTop: 12 }}>
          Invite link (share if email is off): <code data-testid="invite-link">{lastLink.url}</code>
          <br /><span style={{ color: "var(--fg-dim)" }}>{lastLink.emailed ? "Emailed to recipient." : "Email not sent — copy the link above."}</span>
        </p>
      )}

      {invites.length > 0 && (
        <>
          <h3>Pending invites</h3>
          <ul>
            {invites.map((i) => (
              <li key={i.id} style={{ marginBottom: 4 }}>
                {i.email || "(no email)"} — {i.role}{" "}
                <button type="button" onClick={() => void guarded(() => revokeInvite(token, i.id))()}>Revoke</button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
