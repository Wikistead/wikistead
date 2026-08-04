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
import { useRoles, useRoleAssignments, useAssignRole, useAssignTenantTier, useUnassignRole, useTenantGroupNames, useTenantRoleDefaults } from "../data/queries";
import { notify } from "../ui/toast";
import { notifyRevokeOutcome, notifyRevokeError } from "./revoke-feedback";
import { buildTenantRoleRows, buildGroupRoleRows, buildUnifiedRows, filterMembers, roleOptions, currentRoleValue, groupRoleValue, adminGroupNames, resolveRoleChoice, BUILT_IN_TIERS } from "./tenant-role-rows";
import { RoleTip } from "../ui/RoleTip"; // #603: the conferred-admin marker explains itself like every role name (#586)
import { TENANT_TIER_CAPS, tenantTierCaps } from "./role-nouns";
import { GranteeRoleForm } from "./GranteeRoleForm"; // #578 bounce ④: one add-flow, shared with the space screen
import { OverflowMenu } from "../ui/OverflowMenu"; // #579 ②: row actions fold away (the #212 pattern)
import { MemberStatusIcons, memberMenuValues } from "./member-status"; // #614: origin / password / suspended, beside the name

// Admin Console: member list (role change / remove) + invites (create / revoke).
// All actions hit admin-only endpoints; a non-admin sees an "admin only" notice
// (the server is the authority — this screen is just chrome).
export function MembersPage() {
  const { t } = useTranslation();
  const { token, sub: me, tenantId } = useSession();
  const [members, setMembers] = useState<Member[]>([]);
  // #578 bounce ④, then the 2026-08-04 ruling ("
  // "): the tenant screen runs the WHOLE shared add-flow — user or group, then who, then which
  // role — the same shape the space screen has. The groups-only round pinned "a person's tenant role is
  // given on their row" (#579); the ruling overrides that pin for the ADD FORM: the row keeps working,
  // and the form is a second door to the same converged state (1 principal = 1 role), not a second state.
  const [granteeType, setGranteeType] = useState<"user" | "group">("user");
  const [userQuery, setUserQuery] = useState("");
  const [pickedUser, setPickedUser] = useState<{ grantee: string; label: string } | null>(null);
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
  // `kind` decides the words: an invite mints a person, a password setup adds an entrance to one who is
  // already here — the review found the second reusing the first's toast, which resurrects exactly
  // the misreading (#606: "an invite = a new person") this ticket exists to remove.
  const [lastLink, setLastLink] = useState<{ url: string; emailed: boolean; kind: "invite" | "password" } | null>(null);
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
  // #603 / ADR-207: the tier grant is its own path — a capability, not a role id, and groups only
  const assignTier = useAssignTenantTier();
  const unassignRole = useUnassignRole();
  // the search #557 put inside the assign form belongs to the TABLE now — it filters the people, which
  // is useful for every column, not just for finding someone to give a role to
  const [filter, setFilter] = useState("");
  // #582 ①: the tiers explain themselves like every other role — but `member`'s answer is this tenant's
  // live switch, not a constant (see tenantTierCaps). Until the defaults arrive the member tier stays
  // bare rather than repeating a default that may be false here.
  const tierDefaults = useTenantRoleDefaults();
  const tierCaps = tenantTierCaps(tierDefaults.data?.member);

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
      setLastLink({ url: res.inviteUrl, emailed: res.emailed, kind: "invite" });
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
    catch (e) {
      // #603 (user condition on the floor ruling): the 409 says WHY. With a group holding admin, the
      // plain "cannot change the last admin" reads as a bug — the reason (group-conferred admins can
      // be lost at the IdP, one DIRECT admin must remain) is the sentence that stops the next person
      // from removing the guard in good faith. The server picks the code; this maps it to the locale.
      setError(
        e instanceof ApiError && e.status === 409 && e.code === "last_direct_admin" ? t("members.lastDirectAdmin")
        : e instanceof ApiError && e.status === 409 ? t("members.lastAdmin")
        : t("toast.actionFailed"),
      );
    }
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
  const unified = buildUnifiedRows(shownMembers, shownGroups, new Set(), adminGroupNames(assignments.data ?? []));
  // #578 bounce ④: the filter field no longer doubles as a way to CREATE a grant. It was the only route
  // a group had, and it was invisible — a reader had to type a name that matched nothing and notice a
  // row appear. Two routes to the same result is what this ticket exists to remove, so the add-flow
  // above is the one route and the filter went back to filtering.
  const tenantCustom = (roles.data?.custom ?? []).filter((r) => r.scope === "tenant");
  const knownGroups = groupNames.data ?? [];
  // The user half of the add form searches the list this screen already holds — the space side asks the
  // server because it cannot see the tenant roster; here the roster IS the page.
  const userCandidates = userQuery.trim() && !pickedUser
    ? filterMembers(members, userQuery).slice(0, 8).map((m) => ({ sub: m.sub, displayName: m.display_name || m.email }))
    : [];

  // #578 (2026-08-04 ruling): the row's Select and the add form are two doors to the SAME change, so the
  // change is one function — the convergence rules (a tier drops the custom roles first; a custom role
  // is swept onto by the server) cannot fork between them.
  const applyUserRole = (sub: string, value: string) => {
    const row = roleRows.get(sub);
    const choice = resolveRoleChoice(value, tenantCustom);
    if (choice.kind === "tier") {
      // A tier IS the whole role once chosen: the custom role they held is not "also" true any more, so
      // it goes with the change rather than lingering invisibly behind a control that now reads
      // `member`. Drop it FIRST — leaving it behind would make the control snap back on the next read.
      // Errors are not swallowed; `guarded` reports them (incl. the last-admin 409's reason).
      void guarded(async () => {
        for (const c of row?.custom ?? []) await unassignRole.mutateAsync(c.assignmentId);
        await changeRole(token, sub, choice.role);
      })();
    } else if (choice.kind === "custom") {
      // The server sweeps whatever else they held at tenant scope (#579): assign is a replacement, and
      // the new role is written before the old one goes.
      assignRole.mutate({ roleId: choice.roleId, resourceType: "tenant", resourceId: tenantId, principal: `user:${sub}` }, {
        onSuccess: () => notify.success(t("toast.saved")),
        onError: () => notify.error(t("toast.actionFailed")),
      });
    }
  };

  if (forbidden) {
    return <div style={{ padding: 24, maxWidth: 560 }}><h2>{t("members.title")}</h2><p style={{ color: "var(--fg-dim)" }}>{t("members.adminOnly")}</p></div>;
  }

  return (
    <div style={{ padding: 24, maxWidth: 720 }}>
      <h2 style={{ marginTop: 0 }}>{t("members.title")}</h2>
      {error && <p style={{ color: "crimson" }}>{error}</p>}

      {/* #579 (review rejection ②, 2026-08-04): .
          They were two rows with nothing between them, so the screen read as one four-control mess.
          Each operation gets a heading — the idiom this page already uses for its invite section, not a
          new one — and the filter now sits with the table it filters rather than above the form. */}
      <h3 className="mb-2 mt-6 text-sm font-medium">{t("members.grantTitle")}</h3>

      {/* #578 bounce ④ (user ruling: " UI "), then the
          2026-08-04 ruling: the SAME form the space screen uses, with the SAME type toggle — user or
          group, find them, choose the role, add. The groups-only round pinned "a person's tenant role is
          given on their row" (#579); that pin is overridden for the add form by the user's direct
          converge on the same state — the server keeps 1 principal = 1 role — so this is a second way to
          say the same thing, not a second thing. */}
      <GranteeRoleForm
        testId="tenant-grant"
        types={["user", "group"]}
        type={granteeType}
        onTypeChange={setGranteeType}
        query={userQuery}
        onQueryChange={setUserQuery}
        picked={pickedUser}
        onPick={(c) => { setPickedUser(c ? { grantee: `user:${c.sub}`, label: c.displayName || c.sub } : null); if (c) setUserQuery(""); }}
        candidates={userCandidates}
        groupName={groupName}
        onGroupNameChange={setGroupName}
        knownGroups={knownGroups}
        // #603 / ADR-207 (overturns ADR-201 §1): the tiers are in the list. Same list-builder as the
        // rows, so the vocabulary cannot fork. The empty first entry is the placeholder — a Select with
        // no matching option rendered as a bare chevron with no width (the 2026-08-04 screenshot).
        roleOptions={[
          { value: "", label: t("adminRoles.rolePlaceholder") },
          ...withRoleTips(roleOptions(roles.data?.custom ?? [], tierCaps), "tenant"),
        ]}
        role={groupRole}
        onRoleChange={setGroupRole}
        pending={assignRole.isPending || assignTier.isPending}
        onAdd={() => {
          const choice = resolveRoleChoice(groupRole, tenantCustom);
          if (choice.kind === "none") return;
          if (granteeType === "user") {
            if (!pickedUser) return;
            applyUserRole(pickedUser.grantee.slice("user:".length), groupRole);
            setPickedUser(null); setUserQuery(""); setGroupRole("");
            return;
          }
          if (!groupName.trim()) return;
          const done = {
            onSuccess: () => { notify.success(t("toast.saved")); setGroupName(""); setGroupRole(""); },
            onError: () => notify.error(t("toast.actionFailed")),
          };
          if (choice.kind === "tier") assignTier.mutate({ capability: choice.role, groupName: groupName.trim() }, done);
          else assignRole.mutate({ roleId: choice.roleId, resourceType: "tenant", resourceId: tenantId, groupName: groupName.trim() }, done);
        }}
      />

      {/* the filter belongs to the TABLE — it narrows what is listed and does nothing else (#578 took
          the granting away from it). Under its own heading, beside the thing it acts on. */}
      <h3 className="mb-2 mt-8 border-t border-border pt-6 text-sm font-medium">{t("members.listTitle")}</h3>
      <FormRow className="mb-2">
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
                {/* #603 / ADR-207 (overturns ADR-201 §1): the group's control reads the SAME vocabulary a
                    person's does — tiers and tenant custom roles, one list-builder, mechanism-prefixed
                    values. The picker that hid half its vocabulary is the thing this ticket removes. */}
                <Select
                  size="sm"
                  value={groupRoleValue(row.group)}
                  ariaLabel={t("members.roleFor", { sub: row.label })}
                  testId="member-role-select"
                  options={[
                    { value: "", label: t("adminRoles.rolePlaceholder") },
                    ...withRoleTips(roleOptions(roles.data?.custom ?? [], tierCaps), "tenant"),
                  ]}
                  onChange={(value) => {
                    const choice = resolveRoleChoice(value, tenantCustom);
                    const held = row.group?.held ?? [];
                    const saved = { onSuccess: () => notify.success(t("toast.saved")), onError: () => notify.error(t("toast.actionFailed")) };
                    if (choice.kind === "none") {
                      // choosing the placeholder is the revocation (#579: the group row's third cell is
                      // empty — this Select is where a grant is taken away). Built-in rows revoke through
                      // the same reference-counted core as custom ones (#603: the DELETE route reads
                      // built-in rows now, and revoking is never entitlement-gated).
                      for (const h of held) if (!h.managed) unassignRole.mutate(h.assignmentId, { onSuccess: (data) => notifyRevokeOutcome(t, data), onError: (err) => notifyRevokeError(t, err) });
                      return;
                    }
                    // both paths converge on the server (#579 / a71d8100): the new grant is written and
                    // the principal's other manual tenant assignments fold — a replacement, not a stack
                    if (choice.kind === "tier") assignTier.mutate({ capability: choice.role, principal: row.key }, saved);
                    else assignRole.mutate({ roleId: choice.roleId, resourceType: "tenant", resourceId: tenantId, principal: row.key }, saved);
                  }}
                />
              </td>
              <td />
            </tr>
          ) : (
            (() => {
              const m = members.find((x) => x.sub === row.sub)!;
              // #614: a suspended member stays listed (the seat they hold must stay visible) but the
              // whole row reads as dormant — the dim is the row's, the Ban mark and its hover words are
              // the icon group's. Controls stay live: a role change while suspended is meaningful
              // (reactivation re-derives FGA from members.role, so it takes effect then).
              return (
            <tr key={m.sub} data-testid={m.deactivated_at != null ? "member-row-deactivated" : undefined}
              style={{ borderBottom: "1px solid var(--border, #222)", opacity: m.deactivated_at != null ? 0.55 : undefined }}>
              <td style={{ padding: "8px 4px" }}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                  <Avatar name={m.display_name || m.email || m.sub} src={m.picture_url} seed={m.sub} size={24} />
                  {m.display_name || m.email || m.sub}{m.sub === me && t("members.you")}
                  {/* #614: the status marks — origin (IdP / password-born), an added password entrance,
                      suspended. Hover explains each (the #586 school); nothing is spelled beside the name. */}
                  <MemberStatusIcons member={m} />
                </span>
              </td>
              {/* #579 (user ruling, 2026-08-03): .
                  One control, and its VALUE is the role this member has. Chips are gone with the concept
                  they drew: a chip row exists to show a SET, and there is no set — the server converges a
                  tenant principal to one role (a71d8100), so a screen showing two was describing a state
                  the mechanism does not produce. Changing the control replaces; there is no "add". */}
              <td data-testid="member-roles">
                {/* ADR-207 rev3 (#603): what a GROUP confers is shown BESIDE the control, never inside
                    it — the Select keeps meaning the row's OWN tier, because a control that appeared to
                    demote somebody while the group kept conferring admin would be the "successful action
                    that changes nothing" this repo has fixed twice (#596, #536). The marker names its
                    source, wears tokens only, and explains itself on hover like every role name (#586). */}
                {row.adminVia && row.adminVia.length > 0 && (
                  <RoleTip origin="role" scope="tenant" roleCapabilities={TENANT_TIER_CAPS.admin} testId={`admin-via-${m.sub}`}>
                    <span data-testid="admin-via-group" className="mr-2 inline-flex items-center gap-1 rounded border border-[var(--accent)] px-1 text-[11px] text-[var(--accent)]">
                      admin
                      <span className="text-fg-dim">{t("members.viaGroup", { group: row.adminVia.join(", ") })}</span>
                    </span>
                  </RoleTip>
                )}
                <Select
                  size="sm"
                  value={currentRoleValue(roleRows.get(m.sub) ?? { sub: m.sub, builtin: m.role, custom: [], addable: [] })}
                  // #617 ⑤: the label is READ ALOUD. A 70-character hex sub is not a name — the row already
                  // renders one, and this is the same string.
                  ariaLabel={t("members.roleFor", { sub: m.display_name || m.email || m.sub })}
                  testId="member-role-select"
                  options={withRoleTips(roleOptions(roles.data?.custom ?? [], tierCaps), "tenant")}
                  onChange={(value) => applyUserRole(m.sub, value)}
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
                  // #614: somebody who already has a password entrance is not offered another — that item
                  // could only ever fail (#606's always-failing button). The server's uniform 400 stays
                  // as the fortress; memberMenuValues is the convenience layer's half, pinned pure.
                  items={[
                    { value: "password", label: t("members.enablePassword"), icon: <KeyRound size={14} />, testId: "member-enable-password" },
                    { value: "erase", label: t("members.eraseAnalytics"), icon: <Eraser size={14} />, testId: "member-erase-analytics", danger: true },
                    { value: "remove", label: t("members.remove"), icon: <UserMinus size={14} />, testId: "member-remove", danger: true },
                  ].filter((i) => memberMenuValues(m).includes(i.value as "password" | "erase" | "remove"))}
                  onSelect={(v) => {
                    if (v === "password") {
                      // NOT through `guarded`: its catch-all is a hard-coded English "Action failed",
                      // which is what the review saw. The refusal is deliberately UNIFORM on the
                      // server (`password_setup_unavailable` never says which precondition failed), and
                      // it stays uniform here — one readable sentence, no reason branch.
                      void (async () => {
                        try {
                          const res = await enablePassword(token, m.sub);
                          setLastLink({ url: res.setupUrl, emailed: false, kind: "password" });
                          notify.success(t("members.enablePasswordDone"));
                        } catch (e) {
                          notify.error(e instanceof ApiError && e.status === 400
                            ? t("members.passwordSetupUnavailable")
                            : t("toast.actionFailed"));
                        }
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
          options={withRoleTips(roleOptions(roles.data?.custom ?? [], tierCaps), "tenant")}
        />
        <Button variant="primary" disabled={!email.trim()} onClick={() => void onInvite()}>{t("members.sendInvite")}</Button>
      </FormRow>
      {lastLink && (
        <p style={{ marginTop: 12 }}>
          {/* #606 (review rejection): a password-setup link is NOT an invite — nobody new is minted — so it
              does not wear the invite's words. The emailed/not-emailed note is the invite flow's fact
              (a setup link is always handed over in person) and only renders there. */}
          {lastLink.kind === "invite"
            ? <>{t("members.inviteLinkLabel")} <code data-testid="invite-link">{lastLink.url}</code>
                <br /><span style={{ color: "var(--fg-dim)" }}>{lastLink.emailed ? t("members.emailed") : t("members.notEmailed")}</span></>
            : <>{t("members.passwordLinkLabel")} <code data-testid="password-setup-link">{lastLink.url}</code></>}
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
