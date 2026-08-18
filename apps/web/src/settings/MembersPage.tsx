import { useCallback, useEffect, useState } from "react";
import { ListRow, ListBox } from "../ui/list-rows";
import { useTranslation } from "react-i18next";
import { useSession } from "../session/SessionProvider";
import { Button } from "../ui/Button";
import { FormRow } from "../ui/FormRow";
import { ConfirmDialog, SecretDialog } from "../ui/dialogs"; // #504: removal / DSAR erasure / invite revoke confirm first
import { Input } from "../ui/Input";
import { Select } from "../ui/Select";
import { Avatar } from "../ui/Avatar";
import {
  listMembers, listInvites, createInvite, revokeInvite, reissueInvite, changeRole, removeMember, eraseMemberAnalytics, enablePassword, removePassword, resetFactors,
  suspendMember, reactivateMember,
  ApiError, type Member, type Invite,
} from "../data/membersApi";
import { User, Users, KeyRound, Eraser, UserMinus, Ban, Undo2, ShieldOff } from "lucide-react"; // #579 ①: the row says which KIND of principal it is; ②: its actions wear icons in the ⋯ menu
import { withRoleTips } from "./role-option-tips"; // #586: role names explain themselves on hover, in one place
import { IconButton } from "../ui/Button";
import { X } from "lucide-react"; // #544: icon component, not a text glyph
import { useRoles, useRoleAssignments, useAssignRole, useAssignTenantTier, useUnassignRole, useTenantGroupNames, useTenantRoleDefaults } from "../data/queries";
import { notify } from "../ui/toast";
import { notifyRevokeOutcome, notifyRevokeError } from "./revoke-feedback";
import { buildTenantRoleRows, buildGroupRoleRows, buildUnifiedRows, filterMembers, roleOptions, currentRoleValue, groupRoleValue, revocableGroupGrants, groupConferredRoles, resolveRoleChoice, BUILT_IN_TIERS } from "./tenant-role-rows";
import { GroupRolesMark } from "./GroupRolesMark"; // #603: what the member's GROUPS confer, folded into one mark
import { RowLead, ROW_LEAD_PX } from "../ui/RowLead"; // #625: one box, so both row kinds start their name at one x
import { tenantTierCaps } from "./role-nouns";
import { GranteeRoleForm } from "./GranteeRoleForm"; // #578 bounce ④: one add-flow, shared with the space screen
import { OverflowMenu } from "../ui/OverflowMenu"; // #579 ②: row actions fold away (the #212 pattern)
import { MemberStatusIcons, memberMenuValues, passwordAction, type MemberMenuValue } from "./member-status"; // #614: origin / password / suspended, beside the name
import { SettingsPane } from "./SettingsShell"; // #735: the pane draws the frame AND the heading

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
  //
  // #646 (reviewer): ONE state and ONE dialog, for both invite doors and the password entrance.
  // There were two — the form's result and the row's — and they drifted twice: first the title (fixed by
  // giving each secret one name), then the note, where only the form added the hand-it-over guidance. Two
  // call sites are two answers, and each reads correctly on its own; the difference only exists when they
  // are put side by side, which no reader ever does. So the second call site is gone rather than
  // corrected, and `emailed` decides the words in the one place that renders them.
  //
  // `mint` is what a ROW-opened invite carries: which invitation to issue a link for. #638 — the
  // dialog holds no secret until the reader asks, because opening it used to mint, and looking at an
  // invitation invalidated the link its recipient already had.
  const [lastLink, setLastLink] = useState<
    { kind: "invite" | "password"; url?: string; emailed?: boolean; mint?: { id: string; email: string } } | null
  >(null);
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

  // #623: the filter is a SERVER query now. Filtering here while the server pages would answer "among
  // the ones already fetched", which reads identically and is a different question. Debounced so
  // a keystroke is not a request; the box keeps its own text so typing never waits on the network.
  const [query, setQuery] = useState("");
  useEffect(() => {
    const id = window.setTimeout(() => setQuery(filter), 250);
    return () => window.clearTimeout(id);
  }, [filter]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [m, i] = await Promise.all([listMembers(token, { q: query }), listInvites(token)]);
      setMembers(m.members);
      setNextCursor(m.nextCursor);
      setInvites(i);
      setForbidden(false);
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) setForbidden(true);
      else setError("Could not load members");
    }
  }, [token, query]);

  useEffect(() => { void refresh(); }, [refresh]);

  // …and the next page is fetched when the reader reaches the end of the box.
  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const more = await listMembers(token, { cursor: nextCursor, q: query });
      setMembers((prev) => [...prev, ...more.members]);
      setNextCursor(more.nextCursor);
    } catch { /* the box keeps what it has; the error surfaces on the next refresh */ }
    finally { setLoadingMore(false); }
  }, [token, query, nextCursor, loadingMore]);

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
      setLastLink({ kind: "invite", url: res.inviteUrl, emailed: res.emailed });
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
  // the server already applied the query; `filterMembers` would now be filtering a filtered page
  const shownMembers = members;
  // #579 ① (user ruling): people and groups are one list. A group holding a tenant role is a principal
  // with a role, exactly like a person, and giving it its own section with its own shape is what made
  // it read as a different kind of thing under different rules.
  const groupRows = buildGroupRoleRows(assignments.data ?? [], t("spaceMembers.unknownGroup"), t("spaceMembers.group"), t("spaceMembers.groupNotSeen"));
  const shownGroups = filter.trim() ? groupRows.filter((g) => g.label.toLowerCase().includes(filter.trim().toLowerCase())) : groupRows;
  const tenantCustomRoles = (roles.data?.custom ?? []).filter((r) => r.scope === "tenant");
  const unified = buildUnifiedRows(shownMembers, shownGroups, new Set(), groupConferredRoles(assignments.data ?? [], tenantCustomRoles));
  // #578 bounce ④: the filter field no longer doubles as a way to CREATE a grant. It was the only route
  // a group had, and it was invisible — a reader had to type a name that matched nothing and notice a
  // row appear. Two routes to the same result is what this ticket exists to remove, so the add-flow
  // above is the one route and the filter went back to filtering.
  const tenantCustom = tenantCustomRoles;
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
    // #735: the refusal is a tab too — it gets the same frame rather than its own inline one.
    return <SettingsPane width="form" title={t("members.title")} description={t("members.adminOnly")} />;
  }

  return (
    // #735: this screen used to write its frame in INLINE STYLES (`style={{ padding: 24 }}`), which is
    // invisible to a sweep over Tailwind classes and was the source of the 24-vs-26 difference the
    // ticket measured — and its heading in a third spelling again (`style={{ marginTop: 0 }}`). Neither
    // is written here any more, so neither can drift.
    <SettingsPane width="list" title={t("members.title")}>
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

      {/* #623 (ruling): a fixed box with the list scrolling INSIDE it, the same shape #581/#539/
          #521/#503 already use — not a pager, which would be a new part. The next page is fetched when
          the reader reaches the bottom, so "how many members does this tenant have" stops deciding how
          tall this screen is. */}
      <div className="max-h-[26rem] overflow-y-auto" data-testid="members-scroller"
        onScroll={(e) => {
          const el = e.currentTarget;
          if (el.scrollTop + el.clientHeight >= el.scrollHeight - 64) void loadMore();
        }}>
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
                  {/* #625: the icon reads at 16px (a lucide glyph drawn at 24 looks fat beside a filled
                      avatar chip), so the BOX is what matches the avatar — 24px, icon centred. Same column,
                      same rule: a person's name and a group's name start at one x. */}
                  <RowLead>
                    <Users size={16} aria-hidden data-testid="row-kind-group" />
                  </RowLead>
                  <span data-testid="group-name">{row.label}</span>
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
                    // #643: the placeholder is a label, not an action. It USED to be the revocation
                    // "choose a role" quietly took one away — which nobody reads it as, and which put a
                    // destructive act in the list of ordinary choices. Revoking moved to the row's ⋯,
                    // where this screen keeps every other destructive action (#591's shape: the dropdown
                    // changes a role, adding and removing are elsewhere).
                    { value: "", label: t("adminRoles.rolePlaceholder"), disabled: true },
                    ...withRoleTips(roleOptions(roles.data?.custom ?? [], tierCaps), "tenant"),
                  ]}
                  onChange={(value) => {
                    const choice = resolveRoleChoice(value, tenantCustom);
                    const saved = { onSuccess: () => notify.success(t("toast.saved")), onError: () => notify.error(t("toast.actionFailed")) };
                    if (choice.kind === "none") return; // unreachable: the placeholder is disabled above
                    // both paths converge on the server (#579 / a71d8100): the new grant is written and
                    // the principal's other manual tenant assignments fold — a replacement, not a stack
                    if (choice.kind === "tier") assignTier.mutate({ capability: choice.role, principal: row.key }, saved);
                    else assignRole.mutate({ roleId: choice.roleId, resourceType: "tenant", resourceId: tenantId, principal: row.key }, saved);
                  }}
                />
              </td>
              <td style={{ textAlign: "right" }}>
                {/* #643: the same ⋯ a person's row wears, so the two rows read alike and destructive
                    actions live in one place on this screen. One item today; it is a menu rather than a
                    bare button because the affordance is what a reader has learned to look for here, and
                    a second group action would otherwise arrive as a different-looking control. */}
                {revocableGroupGrants(row.group).length > 0 && (
                  <OverflowMenu
                    testId="group-actions"
                    label={t("members.rowActions", { name: row.label })}
                    items={[{ value: "unassign", label: t("members.groupUnassign"), danger: true, testId: "group-unassign" }]}
                    onSelect={() => setConfirming({
                      message: t("members.groupUnassignConfirm", { group: row.label }),
                      run: () => {
                        // the same call the placeholder used to make, and the same skip: a machine-held
                        // row (ADR-183 §1) is not this console's to take away. Moved, not rewritten — a
                        // fresh implementation is where that skip goes missing.
                        for (const h of revocableGroupGrants(row.group)) {
                          unassignRole.mutate(h.assignmentId, { onSuccess: (data) => notifyRevokeOutcome(t, data), onError: (err) => notifyRevokeError(t, err) });
                        }
                      },
                    })}
                  />
                )}
              </td>
            </tr>
          ) : (
            (() => {
              const m = members.find((x) => x.sub === row.sub)!;
              // #614: a suspended member stays listed (the seat they hold must stay visible) but the
              // whole row reads as dormant. #614 (review rejection, measured): the dim used to be on the
              // <tr>, which put it on the status marks too — their contrast fell to 2.22:1 in light, under
              // the 3:1 a non-text UI element needs, and the name to 3.65:1, under 4.5:1. The dim is on
              // the NAME now; the marks (which are how you learn the row is suspended) and the actions
              // keep full opacity. Dormant is said by the Ban mark and the muted name, not by making the
              // evidence hard to see.
              const dimmed = m.deactivated_at != null;
              return (
            <tr key={m.sub} data-testid={dimmed ? "member-row-deactivated" : undefined}
              style={{ borderBottom: "1px solid var(--border, #222)" }}>
              <td style={{ padding: "8px 4px" }}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                  {/* #625: the same one number the group row's box uses — they cannot drift apart */}
                  <Avatar name={m.display_name || m.email || m.sub} src={m.picture_url} seed={m.sub} size={ROW_LEAD_PX} />
                  <span data-testid="member-name" style={{ opacity: dimmed ? 0.7 : undefined }}>
                    {m.display_name || m.email || m.sub}{m.sub === me && t("members.you")}
                  </span>
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
                {/* #603 (review rejection 2026-08-05, ruling): the badge-per-role shape that used to
                    sit here is RETRACTED. It stacked above the control and stretched the row to 57px
                    against 41px for every other one, and a member in three groups stretched it further —
                    now, beside the control, carrying the count; the group × role pairs are behind its
                    hover. See GroupRolesMark. */}
                <span className="inline-flex items-center">
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
                <GroupRolesMark roles={row.groupRoles ?? []} tierCaps={tierCaps} />
                </span>
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
                    {
                      value: "password",
                      // #614 (review rejection): the same door, two errands. Somebody with no password gets
                      // one; somebody who has one gets a fresh link — which is how an admin helps a person
                      // who cannot read the email the self-service reset sends.
                      label: passwordAction(m) === "reissue" ? t("members.reissuePassword") : t("members.enablePassword"),
                      icon: <KeyRound size={14} />,
                      testId: passwordAction(m) === "reissue" ? "member-reissue-password" : "member-enable-password",
                    },
                    // #626: only offered when the server would accept it — see memberMenuValues.
                    { value: "passwordRemove", label: t("members.removePassword"), icon: <KeyRound size={14} />, testId: "member-remove-password", danger: true },
                    // #644 only for a member who holds one — see memberMenuValues. Not `danger`
                    // the other red items take something away, and this one gives a locked-out person
                    // their account back. Colouring it as destruction would describe the wrong act.
                    { value: "factorReset", label: t("members.resetFactors"), icon: <ShieldOff size={14} />, testId: "member-reset-factors" },
                    // #627: one of these at a time — see memberMenuValues.
                    { value: "suspend", label: t("members.suspend"), icon: <Ban size={14} />, testId: "member-suspend", danger: true },
                    { value: "reactivate", label: t("members.reactivate"), icon: <Undo2 size={14} />, testId: "member-reactivate" },
                    { value: "erase", label: t("members.eraseAnalytics"), icon: <Eraser size={14} />, testId: "member-erase-analytics", danger: true },
                    { value: "remove", label: t("members.remove"), icon: <UserMinus size={14} />, testId: "member-remove", danger: true },
                  ].filter((i) => memberMenuValues(m).includes(i.value as MemberMenuValue))}
                  onSelect={(v) => {
                    if (v === "password") {
                      // NOT through `guarded`: its catch-all is a hard-coded English "Action failed",
                      // which is what the review saw. The refusal is deliberately UNIFORM on the
                      // server (`password_setup_unavailable` never says which precondition failed), and
                      // it stays uniform here — one readable sentence, no reason branch.
                      void (async () => {
                        try {
                          const res = await enablePassword(token, m.sub);
                          setLastLink({ kind: "password", url: res.setupUrl });
                          notify.success(t(passwordAction(m) === "reissue" ? "members.reissuePasswordDone" : "members.enablePasswordDone"));
                        } catch (e) {
                          notify.error(e instanceof ApiError && e.status === 400
                            ? t("members.passwordSetupUnavailable")
                            : t("toast.actionFailed"));
                        }
                      })();
                      return;
                    }
                    if (v === "passwordRemove") {
                      // #626: the entrance is coming off — a confirmation, like every other destructive
                      // item here (#504), and the two refusals are named rather than folded into
                      // "Action failed" (#596/#606: a reason nobody can read is a failure twice).
                      setConfirming({
                        message: t("members.removePasswordConfirm", { name: m.display_name || m.email || m.sub }),
                        run: () => void (async () => {
                          try {
                            await removePassword(token, m.sub);
                            await refresh();
                            notify.success(t("members.removePasswordDone"));
                          } catch (e) {
                            const code = e instanceof ApiError ? e.code : undefined;
                            notify.error(code === "last_way_in" ? t("members.removePasswordLastWayIn")
                              : code === "sso_exemption_required" ? t("members.removePasswordSsoFloor")
                              : t("toast.actionFailed"));
                          }
                        })(),
                      });
                      return;
                    }
                    if (v === "factorReset") {
                      // Confirmed like every other consequential item (#504), and the confirmation says
                      // what the member will have to do afterwards — enrol again. Somebody reading it
                      // is usually on the phone with the person it affects.
                      setConfirming({
                        message: t("members.resetFactorsConfirm", { name: m.display_name || m.email || m.sub }),
                        run: () => void (async () => {
                          try {
                            await resetFactors(token, m.sub);
                            await refresh();
                            notify.success(t("members.resetFactorsDone"));
                          } catch (e) {
                            // The one named refusal: aiming it at yourself. Your own factor proves itself
                            // first (#660), and folding that into "Action failed" would leave an admin
                            // pressing a button that cannot work without saying why (#596/#606).
                            notify.error(e instanceof ApiError && e.code === "reset_self"
                              ? t("members.resetFactorsSelf")
                              : t("toast.actionFailed"));
                          }
                        })(),
                      });
                      return;
                    }
                    if (v === "suspend" || v === "reactivate") {
                      // #627 ruling 3: the groups are cleared by the suspension and the DIRECTORY puts
                      // them back — for a member with no IdP they simply do not come back. Said here,
                      // in the confirmation, rather than left to be discovered afterwards.
                      const isSuspend = v === "suspend";
                      setConfirming({
                        message: t(isSuspend ? "members.suspendConfirm" : "members.reactivateConfirm",
                          { name: m.display_name || m.email || m.sub }),
                        run: () => void guarded(async () => {
                          await (isSuspend ? suspendMember(token, m.sub) : reactivateMember(token, m.sub));
                        })(),
                      });
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
      {nextCursor && (
        <button type="button" data-testid="members-more" onClick={() => void loadMore()} disabled={loadingMore}
          className="m-2 rounded-md border border-border px-2 py-1 text-xs text-fg-dim">
          {t("spacePages.more")}
        </button>
      )}
      </div>

      {/* #638 ②: sections on this page are separated the way #579 separated them above — the same
          heading class, the same rule and gap. Inviting somebody and looking over who has not answered
          yet are different acts, and pressed together they read as one block. */}
      <h3 className="mb-2 mt-8 border-t border-border pt-6 text-sm font-medium">{t("members.inviteTitle")}</h3>
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
      {/* #638 (user ruling): a modal, because the links are produced from DIFFERENT places — the
          invite from the form above, the password entrance from a row's ⋯ menu most of a screen away, an
          invitation's link from its own row — and a result rendered in one fixed spot is in the wrong
          place for at least one of them.
          #606 stays honoured: a password-setup link is not an invite, so it wears its own title, and the
          emailed/not-emailed note is the invite flow's fact and renders only there.
          #638/ opening is free; minting is the second press.
          #646 ONE dialog. There were two of these, and both of them rendered an invite link —
          which is how the same secret ended up with two titles, and then, after that was fixed, with two
          different notes. What the reader sees is decided HERE, from `kind` and `emailed`, and there is
          no second place for it to be decided differently. */}
      <SecretDialog
        open={lastLink !== null}
        onClose={() => setLastLink(null)}
        testId={lastLink?.kind === "password" ? "password-setup-link" : "invite-link"}
        title={lastLink?.kind === "password" ? t("members.passwordLinkTitle") : t("members.inviteLinkOpen")}
        secret={lastLink?.url ?? ""}
        note={lastLink?.kind === "password"
          // what the old title carried in brackets: who this is for. It is guidance about the secret,
          // which is what the note under the value is, rather than part of its name.
          ? t("members.passwordLinkNote")
          // …and for an invite, the ONE fact the reader needs: whether it went by mail, or whether
          // handing it over is now their job. One sentence per state — the two used to be concatenated,
          // which put "if email is off" after "Emailed to recipient." (a condition that had already not
          // applied) and said "copy the link above" and "share it yourself" as if they were two steps.
          : lastLink?.url ? t(lastLink.emailed ? "members.emailed" : "members.notEmailed") : undefined}
        warn={lastLink?.mint ? t("members.inviteLinkWarn") : undefined}
        actions={lastLink?.mint && (
          <>
            <Button variant="primary" size="sm" data-testid="invite-link-mint"
              onClick={() => void guarded(async () => {
                const r = await reissueInvite(token, lastLink.mint!.id);
                setLastLink((s) => (s ? { ...s, url: r.inviteUrl, emailed: r.emailed } : s));
              })()}>{t("members.inviteLinkMint")}</Button>
            {lastLink.mint.email !== t("members.noEmail") && (
              <Button variant="ghost" size="sm" data-testid="invite-link-mint-mail"
                onClick={() => void guarded(async () => {
                  const r = await reissueInvite(token, lastLink.mint!.id, { email: true });
                  setLastLink((s) => (s ? { ...s, url: r.inviteUrl, emailed: r.emailed } : s));
                })()}>{t("members.inviteLinkMintMail")}</Button>
            )}
          </>
        )}
      />

      {invites.length > 0 && (
        <>
          <h3 className="mb-2 mt-8 border-t border-border pt-6 text-sm font-medium">{t("members.pendingTitle")}</h3>
          {/* #638 ③: the shared list box from #639 — it grows with the invitations and scrolls only once
              it is tall, so twenty of them no longer push the page down forever. */}
          <ListBox data-testid="invite-list">
            {invites.map((i) => (
              <ListRow key={i.id} data-testid="invite-row" data-invite={i.id}>
                {/* #638 ④: columns, not one sentence. " · " as a single string moved the
                    buttons left and right with the length of the address, so the control a reader was
                    reaching for was never in the same place twice. The address takes the free space and
                    truncates; everything after it is fixed-width and lines up down the list. */}
                <span className="min-w-0 flex-1 truncate" data-testid="invite-email">{i.email || t("members.noEmail")}</span>
                <span className="flex-none text-xs text-fg-dim" data-testid="invite-role-label">{i.role}</span>
                {/* #638 one button, and it is a NOUN. Two lived here — "new link" and "resend"
                    calling the same endpoint, so "resend" re-issued and quietly killed the link the
                    recipient was holding. Issuing is now a second, deliberate press inside the dialog.
                    (The row also carried "emailed / not emailed", which said the same thing on every row
                    — mail is configured for the tenant or it is not — so it said nothing. Removed from
                    the screen; `last_emailed_at` stays in the table so a future "this one failed" mark
                    has something to read, and NOTHING reads it today.) */}
                <Button variant="ghost" size="sm" className="flex-none" data-testid="invite-link-open"
                  onClick={() => setLastLink({ kind: "invite", mint: { id: i.id, email: i.email || t("members.noEmail") } })}>
                  {t("members.inviteLinkOpen")}
                </Button>
                {/* #504: revoking kills the sent link for good — confirm first. */}
                <Button variant="dangerGhost" size="sm" className="flex-none" data-testid="invite-revoke"
                  onClick={() => setConfirming({ message: t("members.revokeConfirm", { email: i.email || t("members.noEmail") }), run: () => void guarded(() => revokeInvite(token, i.id))() })}>{t("members.revoke")}</Button>
              </ListRow>
            ))}
          </ListBox>
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
    </SettingsPane>
  );
}
