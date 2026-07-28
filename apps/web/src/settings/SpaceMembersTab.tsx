import { useState } from "react";
import { useOutletContext } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { MemberSearchInput } from "../ui/MemberSearchInput";
import {
  useSpaceAccess, useGrantSpaceAccess, useRevokeSpaceAccess, useMemberCandidates, useTenantGroups,
  useCommentOpen, useSetCommentOpen,
  useAssignableRoles, useRoleAssignments, useAssignRole, useUnassignRole,
  type PageRelation,
} from "../data/queries";
import { Button, IconButton } from "../ui/Button";
import { Select } from "../ui/Select";
import { notify } from "../ui/toast";
import { Switch } from "../ui/Switch";
import { SpaceGroupMappings } from "./SpaceGroupMappings";

interface SpaceCtx { spaceId: string; name: string }
// #330 / ADR-141: `moderate` → space#moderator (revert/freeze/patrol + edit; grants/settings stay manage-only).
// #529 / ADR-193: `comment` became a space capability (space#commenter). Two different lists follow from
// that, and conflating them is what the review rejected — "why is a role that isn't in the roles
// list showing up here?".
//
// ORDER covers every capability a grant row can HOLD, because rows sort by indexOf and anything missing
// lands at -1 and floats above the rest. A comment grant made through the API (or before this change) has
// to display correctly.
const CAP_ORDER: PageRelation[] = ["view", "comment", "edit", "moderate", "manage"];
// #536 / ADR-188 §6: ONE picker, built-ins beside custom roles. `commenter` was held back because
// offering it here while the Roles tab did not list it made the product speak with two voices — a name
// that was a role on one screen and absent from the other. That was a symptom of having two pickers, and
// this slice is the place the earlier note pointed at: with a single list there is no other list to
// disagree with, so the capability becomes grantable by the same act that removes the mismatch.
const GRANTABLE: PageRelation[] = ["view", "comment", "edit", "moderate", "manage"];
// #445the WIRE value stays the verb (the internal relation — view→viewer_member, edit→editor_member,
// etc. — is unchanged), but the LABEL is the noun a role is called, shown as a literal to match the Roles tab
// (which renders `r.name` verbatim). One noun set across Members and Roles.
const CAP_NOUN: Record<PageRelation, string> = { view: "viewer", comment: "commenter", edit: "editor", moderate: "moderator", manage: "manager" };
const capNoun = (c: string): string => CAP_NOUN[c as PageRelation] ?? c;

// Space Members & Permissions (Phase 5b). manage-gated end-to-end: the screen is
// only reachable by a manager (SpaceSettingsLayout), and every grant/revoke/list
// re-checks space#manage server-side. Granting is the inheritance root — it widens
// access to every published page in the space.
export function SpaceMembersTab() {
  const { t } = useTranslation();
  const { spaceId } = useOutletContext<SpaceCtx>();
  const access = useSpaceAccess(spaceId);
  const grant = useGrantSpaceAccess(spaceId);
  const revoke = useRevokeSpaceAccess(spaceId);
  const commentOpen = useCommentOpen(spaceId);
  const setCommentOpen = useSetCommentOpen(spaceId);
  const toggleCommentOpen = (key: "guests" | "members", value: boolean) =>
    setCommentOpen.mutate({ [key]: value }, {
      onSuccess: () => notify.success(t("toast.saved")),
      onError: () => notify.error(t("toast.actionFailed")),
    });

  const [mode, setMode] = useState<"user" | "group">("user");
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<{ grantee: string; label: string } | null>(null);
  const [groupName, setGroupName] = useState("");
  const [capability, setCapability] = useState<PageRelation>("view");
  // #536: ONE selection for the merged list. The prefix says which mechanism the choice belongs to, so the
  // add handler dispatches on data rather than inferring it from the shape of an id.
  const [pick, setPick] = useState<string>("builtin:view");
  const candidates = useMemberCandidates(spaceId, picked ? "" : query);
  const groups = useTenantGroups(spaceId, mode === "group");

  // #485 / #514: custom-role assignment lives here in space settings (not the tenant Roles tab). The role
  // DEFINITIONS come from the manager-readable list; assign/list/unassign reuse the manage-gated role_assignment
  // routes with resourceType="space". The tenant Roles tab keeps DEFINITION editing; here a manager only ASSIGNS.
  const assignable = useAssignableRoles(spaceId);
  const roleAssignments = useRoleAssignments("space", spaceId);
  const assignRole = useAssignRole();
  const unassignRole = useUnassignRole();
  const customRoles = assignable.data?.custom ?? [];
  // #523 / ADR-190 (slice E): the assignment list now arrives with its user principals already NAMED by the
  // server (the same authorization-bounded resolution as the grant list). The old customized-only lookup is
  // gone — it left an un-customised member showing a raw sub, the last hash on this screen.
  const roleNameBySub = new Map(
    (roleAssignments.data ?? [])
      .filter((a) => a.principal.startsWith("user:"))
      .map((a) => [a.principal.replace(/^user:/, ""), a.displayName ?? null] as const),
  );
  const rolePrincipalLabel = (principal: string): string => {
    if (principal.startsWith("group:")) return `${principal.replace(/^group:/, "").replace(/#member$/, "")} (${t("spaceMembers.group")})`;
    const sub = principal.replace(/^user:/, "");
    return roleNameBySub.get(sub) || sub; // server-resolved name; raw sub only for a departed/cross-tenant one
  };

  // #536 / ADR-188 §6: one control, two mechanisms underneath. A custom role goes through the assignment
  // path (its bundle expands server-side); a built-in goes through the grant path. Either way the server
  // re-gates on space `manage` — the merge is a UI convenience and moves no authority.
  const addUnified = () => {
    if (pick.startsWith("role:")) {
      const id = pick.slice("role:".length);
      // Groups: the assignment path takes a group PRINCIPAL, the same one the mapping feature uses.
      // #536send the group NAME, never a principal we built. The FGA id is a tenant-salted hash
      // the server derives; guessing it here writes a tuple that no membership points at, and the toast
      // would say it worked. The mapping feature has always sent the name for this reason.
      const target = mode === "group"
        ? (groupName ? { groupName } : null)
        : (picked ? { principal: picked.grantee } : null);
      if (!id || !target) return;
      assignRole.mutate({ roleId: id, resourceType: "space", resourceId: spaceId, ...target }, {
        onSuccess: () => { notify.success(t("toast.accessGranted")); setPicked(null); setQuery(""); setGroupName(""); },
        onError: () => notify.error(t("toast.actionFailed")),
      });
      return;
    }
    setCapability(pick.slice("builtin:".length) as PageRelation);
    addBuiltIn(pick.slice("builtin:".length) as PageRelation);
  };

  const addBuiltIn = (capability: PageRelation) => {
    if (mode === "group") {
      if (!groupName) return;
      grant.mutate({ groupName, capability }, {
        onSuccess: () => notify.success(t("toast.accessGranted")),
        onError: () => notify.error(t("toast.actionFailed")),
      });
      setGroupName("");
      return;
    }
    if (!picked) return;
    grant.mutate({ grantee: picked.grantee, capability }, {
      onSuccess: () => notify.success(t("toast.accessGranted")),
      onError: () => notify.error(t("toast.actionFailed")),
    });
    setPicked(null);
    setQuery("");
  };

  const grants = (access.data ?? []).slice().sort((a, b) => CAP_ORDER.indexOf(b.capability) - CAP_ORDER.indexOf(a.capability));
  // #523 / ADR-190 slice D: the server now resolves each user grantee's full name (override ?? OIDC
  // display_name) on the manage-gated grant list (slice A), so an un-customized member reads as their
  // name, not a sub — the #513 root fix. A departed / cross-tenant sub comes back null and falls back to
  // the sub, unchanged. (This supersedes the customized-only /members/identities lookup here.)
  const label = (g: { grantee: string; groupName?: string; displayName?: string | null }) => {
    if (g.groupName) return `${g.groupName} (${t("spaceMembers.group")})`;
    if (g.grantee.startsWith("group:")) return `${g.grantee.replace(/^group:/, "").replace(/#member$/, "")} (${t("spaceMembers.group")})`;
    const sub = g.grantee.replace(/^user:/, "");
    return g.displayName || sub;
  };

  return (
    <div className="max-w-[640px] p-6" data-testid="space-members">
      <h2 className="mt-0">{t("spaceMembers.title")}</h2>
      <p className="mt-0 text-sm text-fg-dim">{t("spaceMembers.body")}</p>

      <div className="mb-6 flex items-start gap-2">
        <Select
          value={mode}
          onChange={(v) => setMode(v as "user" | "group")}
          ariaLabel={t("spaceMembers.granteeType")}
          testId="space-grant-type"
          size="sm"
          options={[
            { value: "user", label: t("spaceMembers.typeUser") },
            { value: "group", label: t("spaceMembers.typeGroup") },
          ]}
        />
        {mode === "group" ? (
          <Select
            value={groupName}
            onChange={(v) => setGroupName(v)}
            ariaLabel={t("spaceMembers.typeGroup")}
            testId="space-grant-group"
            size="sm"
            options={[
              { value: "", label: t("spaceMembers.selectGroup") },
              ...((groups.data ?? []).map((g) => ({ value: g, label: g }))),
            ]}
          />
        ) : (
        <MemberSearchInput
          query={query}
          onQueryChange={setQuery}
          picked={picked}
          onPick={(c) => { setPicked(c ? { grantee: `user:${c.sub}`, label: c.displayName || c.sub } : null); if (c) setQuery(""); }}
          candidates={candidates.data ?? []}
          placeholder={t("spaceMembers.addPlaceholder")}
          ariaLabel={t("spaceMembers.addPlaceholder")}
          inputTestId="space-grant-input"
          listTestId="space-grant-candidates"
          itemTestId="space-grant-candidate"
        />
        )}
        {/* #536 / ADR-188 §6: built-in roles and custom roles are ONE list. They remain two mechanisms
            underneath (a built-in is a capability grant, a custom role expands its bundle), but that is an
            implementation fact and was never a reason to make someone choose which of two controls to use.
            The value carries the kind so the click below dispatches without guessing. */}
        <Select
          value={pick}
          onChange={setPick}
          ariaLabel={t("spaceMembers.capability")}
          testId="space-grant-capability"
          size="sm"
          options={[
            ...GRANTABLE.map((c) => ({ value: `builtin:${c}`, label: capNoun(c) })),
            ...customRoles.map((r) => ({ value: `role:${r.id}`, label: r.name })),
          ]}
        />
        <Button variant="primary" size="sm" disabled={(mode === "group" ? !groupName : !picked) || grant.isPending || assignRole.isPending} onClick={addUnified} data-testid="space-grant-add">{t("spaceMembers.add")}</Button>
      </div>

      {/* #539: the grant list scrolls INSIDE a bounded box — the third instance of the same failure
          (#503 audit ledger, #521 patrol queue), so it takes the same 26rem box rather than a third
          bespoke treatment. A space with many members used to push everything below it — the custom-role
          assignments and the group mappings — past the fold, which is the whole reason those sections
          were hard to reach. The page keeps its own scroll; only this list scrolls. */}
      <div className="flex max-h-[26rem] flex-col gap-1 overflow-y-auto rounded-md border border-border p-1" data-testid="space-grant-list">
        {grants.map((g) => (
          <div key={`${g.grantee}:${g.capability}`} className="flex items-center gap-2.5 rounded-md border border-border px-2.5 py-2" data-testid="space-grant-item">
            <span className="min-w-[52px] flex-none rounded-full border border-border px-2 py-px text-center text-[11px] uppercase tracking-[0.03em] text-fg-dim data-[cap=manage]:border-[var(--accent)] data-[cap=manage]:text-[var(--accent)]" data-cap={g.capability}>{capNoun(g.capability)}</span>
            <span className="min-w-0 flex-1 text-sm [overflow-wrap:anywhere]">{label(g)}</span>
            {/* #504: red at rest; no confirm — a grant is re-grantable in one step (exception candidate) */}
            <IconButton aria-label={t("spaceMembers.revoke")} data-testid="space-grant-revoke" variant="danger"
              onClick={() => revoke.mutate({ grantee: g.grantee, capability: g.capability }, {
                onSuccess: () => notify.success(t("toast.accessRevoked")),
                onError: () => notify.error(t("toast.actionFailed")),
              })}>
              <X size={14} />
            </IconButton>
          </div>
        ))}
        {grants.length === 0 && <p className="text-sm text-fg-dim">{t("spaceMembers.empty")}</p>}
      </div>

      {/* #485 / #514: custom-role assignments for THIS space (roles are DEFINED in the tenant Roles tab and
          only ASSIGNED here). Each assignment expands to the role's capability bundle server-side,
          manage-gated.
          #536 / ADR-188 §6: this section no longer carries its own add form. Adding is ONE control — the
          merged picker above, where a custom role sits in the same list as a built-in capability. The
          second form was strictly weaker (users only, never groups) and it built its principal string
          itself, which is exactly where thegroup bug came from: two places constructing a principal
          means one of them can be wrong while the other is right. What remains here is the LIST, which the
          grant list above cannot show — an assignment is a role, not a capability. */}
      {(customRoles.length > 0 || (roleAssignments.data?.length ?? 0) > 0) && (
        <div className="mt-8 border-t border-border pt-4" data-testid="space-role-assign">
          <h3 className="mt-0 text-sm font-medium">{t("spaceMembers.customRolesTitle")}</h3>
          <p className="mt-0 mb-3 text-sm text-fg-dim">{t("spaceMembers.customRolesBody")}</p>
          {/* #539: same bound for the assignment list — it grows with the same membership. */}
          <div className="flex max-h-[26rem] flex-col gap-1 overflow-y-auto rounded-md border border-border p-1" data-testid="space-role-assign-list">
            {(roleAssignments.data ?? []).map((a) => (
              <div key={a.id} className="flex items-center gap-2.5 rounded-md border border-border px-2.5 py-2" data-testid="space-role-assign-item">
                <span className="min-w-[52px] flex-none rounded-full border border-[var(--accent)] px-2 py-px text-center text-[11px] uppercase tracking-[0.03em] text-[var(--accent)]">{a.roleName}</span>
                <span className="min-w-0 flex-1 text-sm [overflow-wrap:anywhere]">{rolePrincipalLabel(a.principal)}</span>
                {/* #504: red at rest; no confirm — an unassignment is re-assignable in one step */}
                <IconButton aria-label={t("spaceMembers.revoke")} data-testid="space-role-assign-revoke" variant="danger"
                  onClick={() => unassignRole.mutate(a.id, {
                    onSuccess: () => notify.success(t("toast.accessRevoked")),
                    onError: () => notify.error(t("toast.actionFailed")),
                  })}>
                  <X size={14} />
                </IconButton>
              </div>
            ))}
            {(roleAssignments.data?.length ?? 0) === 0 && <p className="text-sm text-fg-dim">{t("spaceMembers.customRolesEmpty")}</p>}
          </div>
        </div>
      )}

      {/* #514 / ADR-188 §8: a mapping onto a SPACE role is this space's configuration, so it lives here
          rather than on the tenant Roles tab (which kept a space picker only tenant admins could reach).
          The server already gated it per resource — creating needs `manage` on this space, and the
          filtered list answers to the same authority. */}
      {customRoles.length > 0 && <SpaceGroupMappings spaceId={spaceId} />}

      {/* #100 / ADR-029: comment AUDIENCE toggles — who may comment on this space's pages. A resource
          setting (space#comment_open), separate from the per-member grants above. Default OFF. */}
      <div className="mt-8 border-t border-border pt-4" data-testid="comment-open">
        <h3 className="mt-0 text-sm font-medium">{t("spaceMembers.commentAudienceTitle")}</h3>
        <p className="mt-0 mb-3 text-sm text-fg-dim">{t("spaceMembers.commentAudienceBody")}</p>
        {([
          { key: "guests" as const, label: t("spaceMembers.commentGuests"), testId: "comment-open-guests" },
          { key: "members" as const, label: t("spaceMembers.commentMembers"), testId: "comment-open-members" },
        ]).map(({ key, label: lbl, testId }) => {
          const on = !!commentOpen.data?.[key];
          return (
            <label key={key} className="mb-2 flex items-center gap-2 text-sm">
              {/* #389 / ADR-146: the hand-rolled role=switch button -> the shared DS Switch. data-on kept
                  for existing assertions. */}
              <Switch checked={on} testId={testId} data-on={on}
                disabled={commentOpen.isLoading || setCommentOpen.isPending}
                onChange={(v) => toggleCommentOpen(key, v)} />
              <span>{lbl}</span>
            </label>
          );
        })}
      </div>
    </div>
  );
}
