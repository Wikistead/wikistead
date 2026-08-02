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
import { notifyRevokeOutcome, notifyRevokeError } from "./revoke-feedback";
import { buildTenantRoleRows, filterMembers, pickerOptions, resolveRoleChoice, BUILT_IN_TIERS } from "./tenant-role-rows";

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
  // #579: ONE invite picker — a tier or a custom role, in the mechanism-prefixed shape the row uses.
  const [inviteChoice, setInviteChoice] = useState("tier:member");
  // #582 / ADR-202 §2: an invite may also carry a TENANT-scope custom role. #579 (third ruling) merged
  // the two Selects that expressed this into ONE: the choice is a tier OR a custom role, and a custom
  // role implies the `member` tier, because a tenant role is something a member also has.
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
      // The one picker's value carries its mechanism, so a custom role named "admin" cannot be read as
      // the tier (the same guard the row uses).
      const choice = resolveRoleChoice(inviteChoice, (roles.data?.custom ?? []).filter((r) => r.scope === "tenant"))
      const res = await createInvite(token, {
        email: email.trim(),
        role: choice.kind === "tier" ? choice.role : "member",
        roleId: choice.kind === "custom" ? choice.roleId : null,
      });
      setLastLink({ url: res.inviteUrl, emailed: res.emailed });
      setEmail("");
      setInviteChoice("tier:member");
      await refresh();
    } catch (e) {
      setError(e instanceof ApiError && e.status === 403 ? t("members.seatLimit") : t("members.inviteFailed"));
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
              {/* #579 (user ruling, THIRD time): one dropdown, and everything is chosen from it.
                  #591 read "just one dropdown" as "give the tier its own dropdown" and split the cell in
                  two, which is the opposite of what was asked. Its OBSERVATION was right — an exclusive
                  tier hidden behind a control labelled "add" reads as though changing a tier adds one —
                  but the fix for that is the LABEL, not a second control. So: one picker that offers the
                  tier the member is not on and the roles they do not hold, and chips that show what they
                  hold now. The asymmetry is told by the chips: a tier chip has no × (you do not remove a
                  tier, you pick the other one), a custom chip does (removal is per assignment — two roles
                  can share a capability and the server's reference count decides what actually goes). */}
              <td data-testid="member-roles">
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                  <span className="rounded-full border border-border px-2 py-px text-[11px] text-fg-dim" data-testid="member-tier-chip">
                    {roleRows.get(m.sub)?.builtin ?? m.role}
                  </span>
                  {(roleRows.get(m.sub)?.custom ?? []).map((c) => (
                    <span key={c.assignmentId} className="inline-flex items-center gap-1 rounded-full border border-[var(--accent)] px-2 py-px text-[11px] text-[var(--accent)]" data-testid="member-role-chip">
                      {c.roleName}
                      {!c.managed && (
                        <IconButton aria-label={t("adminRoles.unassign")} data-testid="member-role-remove" variant="danger"
                          onClick={() => unassignRole.mutate(c.assignmentId, {
                            // #596: a removal that leaves the capability covered by another role says so
                            onSuccess: (data) => notifyRevokeOutcome(t, data),
                            onError: (err) => notifyRevokeError(t, err),
                          })}><X size={12} /></IconButton>
                      )}
                    </span>
                  ))}
                  <Select
                    size="sm"
                    value=""
                    ariaLabel={t("members.roleFor", { sub: m.sub })}
                    testId="member-role-select"
                    options={[{ value: "", label: t("members.roleChangeOrAdd") },
                      ...pickerOptions(roleRows.get(m.sub) ?? { sub: m.sub, builtin: m.role, custom: [], addable: [] })]}
                    onChange={(value) => {
                      const choice = resolveRoleChoice(value, roleRows.get(m.sub)?.addable ?? []);
                      if (choice.kind === "tier") {
                        void guarded(() => changeRole(token, m.sub, choice.role))();
                      } else if (choice.kind === "custom") {
                        assignRole.mutate({ roleId: choice.roleId, resourceType: "tenant", resourceId: tenantId, principal: `user:${m.sub}` }, {
                          onSuccess: () => notify.success(t("toast.saved")),
                          onError: () => notify.error(t("toast.actionFailed")),
                        });
                      }
                    }}
                  />
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
        {/* One dropdown here too (#579, same ruling): the tiers and the tenant custom roles in one list.
            Picking a tier invites at that tier; picking a custom role invites at `member` and grants the
            role on acceptance — which is what the two Selects said together, minus the "no custom role"
            option that existed only to say "I am the other control". */}
        <Select
          value={inviteChoice}
          onChange={setInviteChoice}
          ariaLabel={t("members.inviteRole")}
          testId="invite-role"
          options={[
            // #582 (user ruling): a built-in role NAME is a proper noun — the same string on every
            // screen, in every locale. The tenant screens used to translate these two while the space
            // screen showed them in English, so one role had two names depending where you looked.
            ...BUILT_IN_TIERS.map((r) => ({ value: `tier:${r}`, label: r })),
            ...(roles.data?.custom ?? []).filter((r) => r.scope === "tenant").map((r) => ({ value: `role:${r.id}`, label: r.name })),
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
                {t("members.pendingRow", { email: i.email || t("members.noEmail"), role: i.role })}{" "}
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
