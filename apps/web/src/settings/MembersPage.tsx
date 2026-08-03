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
  listMembers, listInvites, createInvite, revokeInvite, changeRole, removeMember, eraseMemberAnalytics, enablePassword,
  ApiError, type Member, type Invite,
} from "../data/membersApi";
import { User, Users, KeyRound, Eraser, UserMinus } from "lucide-react"; // #579 ①: the row says which KIND of principal it is; ②: its actions wear icons in the ⋯ menu
import { withRoleTips } from "./role-option-tips"; // #586: role names explain themselves on hover, in one place
import { IconButton } from "../ui/Button";
import { X } from "lucide-react"; // #544: icon component, not a text glyph
import { useRoles, useRoleAssignments, useAssignRole, useUnassignRole, useTenantGroupNames } from "../data/queries";
import { notify } from "../ui/toast";
import { notifyRevokeOutcome, notifyRevokeError } from "./revoke-feedback";
import { buildTenantRoleRows, buildGroupRoleRows, buildUnifiedRows, filterMembers, roleOptions, currentRoleValue, resolveRoleChoice, BUILT_IN_TIERS } from "./tenant-role-rows";
import { GranteeRoleForm } from "./GranteeRoleForm"; // #578 bounce ④: one add-flow, shared with the space screen
import { OverflowMenu } from "../ui/OverflowMenu"; // #579 ②: row actions fold away (the #212 pattern)

// Admin Console: member list (role change / remove) + invites (create / revoke).
// All actions hit admin-only endpoints; a non-admin sees an "admin only" notice
// (the server is the authority — this screen is just chrome).
export function MembersPage() {
  const { t } = useTranslation();
  const { token, sub: me, tenantId } = useSession();
  const [members, setMembers] = useState<Member[]>([]);
  // #578 bounce ④: the tenant screen's own half of the shared add-flow. Groups only — a person's tenant
  // role is given on their row (#579) and their arrival is the invite above; a group has neither, and
  // before this the only way to give one a role was to type a name that matched nothing in the FILTER
  // field and notice that a row appeared. Nothing on the screen said so.
  const [groupName, setGroupName] = useState("");
  const [groupRole, setGroupRole] = useState("");
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
      // #606: the server refuses an invite to somebody who is already here, and says so — that answer
      // is worth repeating rather than flattening into "could not create the invite", because the admin
      // was trying to do something reasonable and the next step depends on knowing why it failed.
      setError(
        e instanceof ApiError && e.code === "already_member" ? t("members.inviteAlreadyMember")
        : e instanceof ApiError && e.status === 403 ? t("members.seatLimit")
        : t("members.inviteFailed"),
      );
    }
  };

  const guarded = (fn: () => Promise<void>) => async () => {
    setError(null);
    try { await fn(); await refresh(); }
    catch (e) { setError(e instanceof ApiError && e.status === 409 ? "Cannot change the last admin." : "Action failed"); }
  };

  // pure, so the asymmetry and the "already held" exclusion are pinned without a DOM
  const groupNames = useTenantGroupNames();
  const roleRows = new Map(
    buildTenantRoleRows(members, assignments.data ?? [], roles.data?.custom ?? []).map((r) => [r.sub, r]),
  );
  const shownMembers = filterMembers(members, filter);
  // #579 ① (user ruling): people and groups are one list. A group holding a tenant role is a principal
  // with a role, exactly like a person, and giving it its own section with its own shape is what made
  // it read as a different kind of thing under different rules.
  const groupRows = buildGroupRoleRows(assignments.data ?? [], t("spaceMembers.unknownGroup"), t("spaceMembers.group"), t("spaceMembers.groupNotSeen"));
  const shownGroups = filter.trim() ? groupRows.filter((g) => g.label.toLowerCase().includes(filter.trim().toLowerCase())) : groupRows;
  const unified = buildUnifiedRows(shownMembers, shownGroups);
  // #578 bounce ④: the filter field no longer doubles as a way to CREATE a grant. It was the only route
  // a group had, and it was invisible — a reader had to type a name that matched nothing and notice a
  // row appear. Two routes to the same result is what this ticket exists to remove, so the add-flow
  // above is the one route and the filter went back to filtering.
  const tenantCustom = (roles.data?.custom ?? []).filter((r) => r.scope === "tenant");
  const knownGroups = groupNames.data ?? [];

  if (forbidden) {
    return <div style={{ padding: 24, maxWidth: 560 }}><h2>{t("members.title")}</h2><p style={{ color: "var(--fg-dim)" }}>{t("members.adminOnly")}</p></div>;
  }

  return (
    <div style={{ padding: 24, maxWidth: 720 }}>
      <h2 style={{ marginTop: 0 }}>{t("members.title")}</h2>
      {error && <p style={{ color: "crimson" }}>{error}</p>}

      {/* #514 / ADR-188 slice 4: a TENANT role is an attribute of a member, so it is granted here
          beside the people — while a SPACE role is granted in that space's Members tab.
          #579: and it is granted ON THE PERSON'S ROW. There is no second place. */}
      <FormRow>
        <Input className="max-w-xs" value={filter} onChange={(e) => setFilter(e.target.value)}
          placeholder={t("members.filterPlaceholder")} aria-label={t("members.filterLabel")} data-testid="members-filter" />
      </FormRow>

      {/* #578 bounce ④ (user ruling: " UI "): the SAME form the
          space screen uses — find the grantee, choose the role, add. Only `types` differs: a space offers
          people and groups, and here a person's tenant role lives on their own row (#579) while their
          arrival is the invite below, so groups are what is left to add. Using the shared component is
          also what gives this screen completion and the confirmed/unconfirmed distinction the space side
          has had since #578 slice 6 — both were missing here because the flow was a filter-field
          side effect rather than a form. */}
      <GranteeRoleForm
        testId="tenant-grant"
        types={["group"]}
        type="group"
        onTypeChange={() => {}}
        query=""
        onQueryChange={() => {}}
        picked={null}
        onPick={() => {}}
        candidates={[]}
        groupName={groupName}
        onGroupNameChange={setGroupName}
        knownGroups={knownGroups}
        // ADR-201: a group holds a tenant CUSTOM role and never a tier, which is why this list is not
        // the row's list. The rule is stated where the options are built rather than filtered in later.
        roleOptions={withRoleTips(tenantCustom.map((r) => ({ value: r.id, label: r.name, roleCapabilities: r.capabilities })), "tenant")}
        role={groupRole}
        onRoleChange={setGroupRole}
        pending={assignRole.isPending}
        onAdd={() => {
          if (!groupName.trim() || !groupRole) return;
          assignRole.mutate({ roleId: groupRole, resourceType: "tenant", resourceId: tenantId, groupName: groupName.trim() }, {
            onSuccess: () => { notify.success(t("toast.saved")); setGroupName(""); setGroupRole(""); },
            onError: () => notify.error(t("toast.actionFailed")),
          });
        }}
      />
      {/* #579 (review rejection, 2026-08-04): this sentence used to sit under the table, where the section it
          described no longer existed and nobody could tell what "these" meant. It belongs to the form
          above it — the one place that offers a group a role — and says why that list has no tiers in it.
          The difference is real (ADR-201: a tier is held by a person so the record shows who), and an
          unexplained absence is what made the earlier shape look arbitrary. */}
      <p className="mt-0 mb-6 text-xs text-fg-dim" data-testid="tenant-group-tiers-note">{t("adminRoles.groupTiersNote")}</p>

      <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: 32 }}>
        <thead>
          <tr style={{ textAlign: "left", borderBottom: "1px solid var(--border, #333)" }}>
            <th style={{ padding: "8px 4px" }}>{t("members.member")}</th><th>{t("members.role")}</th><th></th>
          </tr>
        </thead>
        <tbody>
          {unified.map((row) => row.kind === "group" ? (
            <tr key={row.key} style={{ borderBottom: "1px solid var(--border, #222)" }} data-testid="member-row-group">
              <td style={{ padding: "8px 4px" }}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                  {/* the kind is an ICON, not a suffix: "(group)" made the label read as part of the name */}
                  <Users size={16} aria-hidden data-testid="row-kind-group" />
                  {row.label}
                </span>
              </td>
              <td data-testid="member-roles">
                {/* A group holds a tenant CUSTOM role and never a tier — ADR-201 retired group-conferred
                    admin so a tenant can always read off WHO holds it, and `member` is universal. The
                    control is the same control; its vocabulary is what differs, and the note under the
                    table says why rather than leaving the absence to be inferred. */}
                <Select
                  size="sm"
                  value={row.group?.held[0]?.assignmentId ? `role:${row.group.held[0].roleName}` : ""}
                  ariaLabel={t("members.roleFor", { sub: row.label })}
                  testId="member-role-select"
                  options={[
                    { value: "", label: t("adminRoles.rolePlaceholder") },
                    // #586 review ②: through the same wrapper the row above it uses. This picker offers
                    // ONLY custom roles, so its labels never touch `capNoun` — which is exactly why the
                    // walk that keyed on `capNoun` could not see it, and why the same roles explained
                    // themselves one row up and said nothing here.
                    ...withRoleTips(tenantCustom.map((r) => ({ value: `role:${r.name}`, label: r.name, roleCapabilities: r.capabilities })), "tenant"),
                  ]}
                  onChange={(value) => {
                    const role = tenantCustom.find((r) => `role:${r.name}` === value);
                    const held = row.group?.held ?? [];
                    if (!role) {
                      for (const h of held) if (!h.managed) unassignRole.mutate(h.assignmentId, { onSuccess: (data) => notifyRevokeOutcome(t, data), onError: (err) => notifyRevokeError(t, err) });
                      return;
                    }
                    // assign converges on the server (a71d8100): the new role is written and the others
                    // swept, so this is a replacement here exactly as it is on a person's row
                    assignRole.mutate({ roleId: role.id, resourceType: "tenant", resourceId: tenantId, principal: row.key }, {
                      onSuccess: () => notify.success(t("toast.saved")),
                      onError: () => notify.error(t("toast.actionFailed")),
                    });
                  }}
                />
              </td>
              <td />
            </tr>
          ) : (
            (() => {
              const m = members.find((x) => x.sub === row.sub)!;
              return (
            <tr key={m.sub} style={{ borderBottom: "1px solid var(--border, #222)" }}>
              <td style={{ padding: "8px 4px" }}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                  <Avatar name={m.display_name || m.email || m.sub} src={m.picture_url} seed={m.sub} size={24} />
                  {m.display_name || m.email || m.sub}{m.sub === me && t("members.you")}
                </span>
              </td>
              {/* #579 (user ruling, 2026-08-03): .
                  One control, and its VALUE is the role this member has. Chips are gone with the concept
                  they drew: a chip row exists to show a SET, and there is no set — the server converges a
                  tenant principal to one role (a71d8100), so a screen showing two was describing a state
                  the mechanism does not produce. Changing the control replaces; there is no "add". */}
              <td data-testid="member-roles">
                <Select
                  size="sm"
                  value={currentRoleValue(roleRows.get(m.sub) ?? { sub: m.sub, builtin: m.role, custom: [], addable: [] })}
                  ariaLabel={t("members.roleFor", { sub: m.sub })}
                  testId="member-role-select"
                  options={withRoleTips(roleOptions(roles.data?.custom ?? []), "tenant")}
                  onChange={(value) => {
                    const row = roleRows.get(m.sub);
                    const choice = resolveRoleChoice(value, (roles.data?.custom ?? []).filter((r) => r.scope === "tenant"));
                    if (choice.kind === "tier") {
                      // A tier IS the whole role once chosen: the custom role they held is not "also"
                      // true any more, so it goes with the change rather than lingering invisibly behind
                      // a control that now reads `member`.
                      void guarded(async () => {
                        // Drop the custom role FIRST, then set the tier: the tier is what the control
                        // will show afterwards, and leaving the assignment behind would make it show the
                        // role again on the next read — the value would snap back and look like the
                        // change was refused. Errors are not swallowed; `guarded` reports them.
                        for (const c of row?.custom ?? []) await unassignRole.mutateAsync(c.assignmentId);
                        await changeRole(token, m.sub, choice.role);
                      })();
                    } else if (choice.kind === "custom") {
                      // The server sweeps whatever else they held at tenant scope (#579): assign is a
                      // replacement, and the new role is written before the old one goes.
                      assignRole.mutate({ roleId: choice.roleId, resourceType: "tenant", resourceId: tenantId, principal: `user:${m.sub}` }, {
                        onSuccess: () => notify.success(t("toast.saved")),
                        onError: () => notify.error(t("toast.actionFailed")),
                      });
                    }
                  }}
                />
              </td>
              <td style={{ textAlign: "right" }}>
                {/* #579 (review rejection, 2026-08-04): three word-buttons per row made the ACTIONS louder than
                    the name and the role, which are what the row is about. Folded into the ⋯ menu the
                    product already uses for occasional actions (#212), rather than inventing a fourth way
                    to show row actions.
                    #464 / ADR-175 §6 (DSAR): erasing a member's reading history is not removing them.
                    #504: both irreversible ones stay red and still confirm before running.
                    #606 / ADR-205 §2: the member keeps their sub and gains a password — the thing an admin
                    was trying to do by sending a password invite, which used to make a second person. */}
                <OverflowMenu
                  testId="member-actions"
                  label={t("members.rowActions", { name: m.display_name || m.email || m.sub })}
                  items={[
                    { value: "password", label: t("members.enablePassword"), icon: <KeyRound size={14} />, testId: "member-enable-password" },
                    { value: "erase", label: t("members.eraseAnalytics"), icon: <Eraser size={14} />, testId: "member-erase-analytics", danger: true },
                    { value: "remove", label: t("members.remove"), icon: <UserMinus size={14} />, testId: "member-remove", danger: true },
                  ]}
                  onSelect={(v) => {
                    if (v === "password") {
                      void guarded(async () => {
                        const res = await enablePassword(token, m.sub);
                        setLastLink({ url: res.setupUrl, emailed: false });
                        notify.success(t("members.enablePasswordDone"));
                      })();
                      return;
                    }
                    if (v === "erase") {
                      setConfirming({ message: t("members.eraseAnalyticsConfirm", { name: m.display_name || m.email || m.sub }), run: () => void guarded(() => eraseMemberAnalytics(token, m.sub))() });
                      return;
                    }
                    setConfirming({ message: t("members.removeConfirm", { name: m.display_name || m.email || m.sub }), run: () => void guarded(() => removeMember(token, m.sub))() });
                  }}
                />
              </td>
            </tr>
              );
            })()
          ))}
        </tbody>
      </table>

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
          // #582 (user ruling): a built-in role NAME is a proper noun — the same string on every screen,
          // in every locale. #586: the same list-builder the rows use, so the invite form cannot drift
          // into explaining roles differently from the table above it.
          options={withRoleTips(roleOptions(roles.data?.custom ?? []), "tenant")}
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
