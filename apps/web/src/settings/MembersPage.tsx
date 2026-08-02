import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSession } from "../session/SessionProvider";
import { Button } from "../ui/Button";
import { FormRow } from "../ui/FormRow";
import { ConfirmDialog } from "../ui/dialogs"; // #504: removal / DSAR erasure / invite revoke confirm first
import { Input } from "../ui/Input";
import { Select } from "../ui/Select";
import { Avatar } from "../ui/Avatar";
import {
  listMembers, listInvites, createInvite, revokeInvite, changeRole, removeMember, eraseMemberAnalytics,
  ApiError, type Member, type Invite,
} from "../data/membersApi";
import { TenantGroupRoles } from "./TenantGroupRoles";
import { IconButton } from "../ui/Button";
import { X } from "lucide-react"; // #544: icon component, not a text glyph
import { useRoles, useRoleAssignments, useAssignRole, useUnassignRole } from "../data/queries";
import { notify } from "../ui/toast";
import { buildTenantRoleRows, filterMembers, pickerOptions, resolveRoleChoice } from "./tenant-role-rows";

// Admin Console: member list (role change / remove) + invites (create / revoke).
// All actions hit admin-only endpoints; a non-admin sees an "admin only" notice
// (the server is the authority — this screen is just chrome).
export function MembersPage() {
  const { t } = useTranslation();
  const { token, sub: me, tenantId } = useSession();
  const [members, setMembers] = useState<Member[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"admin" | "member">("member");
  const [lastLink, setLastLink] = useState<{ url: string; emailed: boolean } | null>(null);
  // #504: every irreversible action here goes through one ConfirmDialog — removal (access + keys +
  // sessions die), DSAR erasure (the reading history is gone for good), invite revoke (the sent link
  // stops working). The pending action carries its own message + handler.
  const [confirming, setConfirming] = useState<{ message: string; run: () => void } | null>(null);
  // #579: roles are an attribute of the member row now — the separate assign form (its own role
  // select, its own member search) is gone. Both mechanisms still exist underneath (built-in =
  // members.role, custom = a role_assignment row FGA expands); the row dispatches to whichever the
  // chosen thing belongs to, which is the same shape the space screen settled on in #536.
  const roles = useRoles();
  const assignments = useRoleAssignments("tenant", tenantId);
  const assignRole = useAssignRole();
  const unassignRole = useUnassignRole();
  // the search #557 put inside the assign form belongs to the TABLE now — it filters the people, which
  // is useful for every column, not just for finding someone to give a role to
  const [filter, setFilter] = useState("");
  const [addingFor, setAddingFor] = useState<string | null>(null);

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

  // pure, so the asymmetry and the "already held" exclusion are pinned without a DOM
  const roleRows = new Map(
    buildTenantRoleRows(members, assignments.data ?? [], roles.data?.custom ?? []).map((r) => [r.sub, r]),
  );
  const shownMembers = filterMembers(members, filter);

  if (forbidden) {
    return <div style={{ padding: 24, maxWidth: 560 }}><h2>{t("members.title")}</h2><p style={{ color: "var(--fg-dim)" }}>{t("members.adminOnly")}</p></div>;
  }

  return (
    <div style={{ padding: 24, maxWidth: 720 }}>
      <h2 style={{ marginTop: 0 }}>{t("members.title")}</h2>
      {error && <p style={{ color: "crimson" }}>{error}</p>}

      {/* #514 / ADR-188 slice 4: a TENANT role is an attribute of a member, so it is granted here —
          beside the people — while a SPACE role is granted in that space's Members tab.
          #579: and it is granted ON THE PERSON'S ROW. There is no second place. */}
      <FormRow>
        <Input className="max-w-xs" value={filter} onChange={(e) => setFilter(e.target.value)}
          placeholder={t("members.filterPlaceholder")} aria-label={t("members.filterLabel")} data-testid="members-filter" />
      </FormRow>

      <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: 32 }}>
        <thead>
          <tr style={{ textAlign: "left", borderBottom: "1px solid var(--border, #333)" }}>
            <th style={{ padding: "8px 4px" }}>{t("members.member")}</th><th>{t("members.role")}</th><th></th>
          </tr>
        </thead>
        <tbody>
          {shownMembers.map((m) => (
            <tr key={m.sub} style={{ borderBottom: "1px solid var(--border, #222)" }}>
              <td style={{ padding: "8px 4px" }}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                  <Avatar name={m.display_name || m.email || m.sub} src={m.picture_url} seed={m.sub} size={24} />
                  {m.display_name || m.email || m.sub}{m.sub === me && t("members.you")}
                </span>
              </td>
              {/* #579 review: this was a built-in Select next to a separate "+ Role" button — two
                  controls for one question, which is exactly what the space screen stopped doing. ONE
                  picker offers the other tier and every custom role the member lacks; what a pick means
                  is decided by resolveRoleChoice, not inferred here. The asymmetry still shows, in the
                  chips rather than in the controls: the tier chip has no × because it is exclusive (you
                  move to the other tier, you do not remove it), custom chips do. */}
              <td data-testid="member-roles">
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                  <span className="rounded-full border border-border px-2 py-px text-[11px] text-fg-dim" data-testid="member-tier-chip">
                    {roleRows.get(m.sub)?.builtin ?? m.role}
                  </span>
                  {(roleRows.get(m.sub)?.custom ?? []).map((c) => (
                    <span key={c.assignmentId} className="inline-flex items-center gap-1 rounded-full border border-[var(--accent)] px-2 py-px text-[11px] text-[var(--accent)]" data-testid="member-role-chip">
                      {c.roleName}
                      {/* removal is PER ASSIGNMENT: two roles can share a capability, and the server's
                          reference count decides what actually goes. A chip that removed "the
                          capability" would take the other role's grant with it. */}
                      {!c.managed && (
                        <IconButton aria-label={t("adminRoles.unassign")} data-testid="member-role-remove" variant="danger"
                          onClick={() => unassignRole.mutate(c.assignmentId, {
                            onSuccess: () => notify.success(t("toast.saved")),
                            onError: () => notify.error(t("toast.actionFailed")),
                          })}><X size={12} /></IconButton>
                      )}
                    </span>
                  ))}
                  {addingFor === m.sub ? (
                    <Select
                      size="sm"
                      value=""
                      ariaLabel={t("members.roleFor", { sub: m.sub })}
                      testId="member-role-add-select"
                      options={[{ value: "", label: t("adminRoles.rolePlaceholder") },
                        ...pickerOptions(roleRows.get(m.sub) ?? { sub: m.sub, builtin: m.role, custom: [], addable: [] })]}
                      onChange={(value) => {
                        const choice = resolveRoleChoice(value, roleRows.get(m.sub)?.addable ?? []);
                        if (choice.kind === "none") return;
                        setAddingFor(null);
                        if (choice.kind === "tier") {
                          void guarded(() => changeRole(token, m.sub, choice.role))();
                          return;
                        }
                        assignRole.mutate({ roleId: choice.roleId, resourceType: "tenant", resourceId: tenantId, principal: `user:${m.sub}` }, {
                          onSuccess: () => notify.success(t("toast.saved")),
                          onError: () => notify.error(t("toast.actionFailed")),
                        });
                      }}
                    />
                  ) : (
                    <Button variant="ghost" size="sm" data-testid="member-role-add" onClick={() => setAddingFor(m.sub)}>{t("members.addRole")}</Button>
                  )}
                </span>
              </td>
              <td style={{ textAlign: "right" }}>
                {/* #464 / ADR-175 §6 (DSAR): erase this member's page-analytics reading history on request
                    (the member keeps their access — distinct from Remove).
                    #504: both are irreversible — red at rest and confirmed before running. */}
                <Button variant="dangerGhost" size="sm" data-testid="member-erase-analytics"
                  onClick={() => setConfirming({ message: t("members.eraseAnalyticsConfirm", { name: m.display_name || m.email || m.sub }), run: () => void guarded(() => eraseMemberAnalytics(token, m.sub))() })}>{t("members.eraseAnalytics")}</Button>
                <Button variant="dangerGhost" size="sm" data-testid="member-remove"
                  onClick={() => setConfirming({ message: t("members.removeConfirm", { name: m.display_name || m.email || m.sub }), run: () => void guarded(() => removeMember(token, m.sub))() })}>{t("members.remove")}</Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* groups are not people and have no row above — their tenant roles live in their own section */}
      <TenantGroupRoles />

      <h3>{t("members.inviteTitle")}</h3>
      <FormRow>
        <Input className="max-w-xs" value={email} onChange={(e) => setEmail(e.target.value)} placeholder={t("members.emailPlaceholder")} aria-label={t("members.inviteEmail")} type="email" />
        <Select
          value={role}
          onChange={(v) => setRole(v as "admin" | "member")}
          ariaLabel={t("members.inviteRole")}
          options={[
            { value: "member", label: t("members.roleMember") },
            { value: "admin", label: t("members.roleAdmin") },
          ]}
        />
        <Button variant="primary" disabled={!email.trim()} onClick={() => void onInvite()}>{t("members.sendInvite")}</Button>
      </FormRow>
      {lastLink && (
        <p style={{ marginTop: 12 }}>
          {t("members.inviteLinkLabel")} <code data-testid="invite-link">{lastLink.url}</code>
          <br /><span style={{ color: "var(--fg-dim)" }}>{lastLink.emailed ? t("members.emailed") : t("members.notEmailed")}</span>
        </p>
      )}

      {invites.length > 0 && (
        <>
          <h3>{t("members.pendingTitle")}</h3>
          <ul>
            {invites.map((i) => (
              <li key={i.id} style={{ marginBottom: 4 }}>
                {i.email || t("members.noEmail")} — {i.role}{" "}
                {/* #504: revoking kills the sent link for good — confirm first. */}
                <Button variant="dangerGhost" size="sm" data-testid="invite-revoke"
                  onClick={() => setConfirming({ message: t("members.revokeConfirm", { email: i.email || t("members.noEmail") }), run: () => void guarded(() => revokeInvite(token, i.id))() })}>{t("members.revoke")}</Button>
              </li>
            ))}
          </ul>
        </>
      )}
      {/* #504: the shared confirm for this page's irreversible actions. */}
      <ConfirmDialog
        open={confirming !== null}
        message={confirming?.message ?? ""}
        confirmTestId="members-confirm"
        confirmLabel={t("common.confirm")}
        onClose={() => setConfirming(null)}
        onConfirm={() => { confirming?.run(); setConfirming(null); }}
      />
    </div>
  );
}
