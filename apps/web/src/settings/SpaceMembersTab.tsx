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
// GRANTABLE is what this picker OFFERS, and it deliberately stops at the four built-in roles the Roles tab
// lists. Offering `commenter` here made the product speak with two voices: a name that is a role in one
// screen and absent from the other, while the standing ruling was that the built-in roles are not
// changing yet — whether `viewer` should include commenting is a question about what viewer MEANS, and it
// belongs to that decision, not to this dropdown. The capability keeps working server-side; the place it
// becomes grantable is #514 / ADR-188 §6, where built-in and custom roles merge into ONE assignment UI and
// the two-lists problem stops existing. Adding it back before then re-creates the mismatch.
const GRANTABLE: PageRelation[] = ["view", "edit", "moderate", "manage"];
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
  const candidates = useMemberCandidates(spaceId, picked ? "" : query);
  const groups = useTenantGroups(spaceId, mode === "group");

  // #485 / #514: custom-role assignment lives here in space settings (not the tenant Roles tab). The role
  // DEFINITIONS come from the manager-readable list; assign/list/unassign reuse the manage-gated role_assignment
  // routes with resourceType="space". The tenant Roles tab keeps DEFINITION editing; here a manager only ASSIGNS.
  const assignable = useAssignableRoles(spaceId);
  const roleAssignments = useRoleAssignments("space", spaceId);
  const assignRole = useAssignRole();
  const unassignRole = useUnassignRole();
  const [roleId, setRoleId] = useState("");
  const [roleQuery, setRoleQuery] = useState("");
  const [rolePicked, setRolePicked] = useState<{ sub: string; label: string } | null>(null);
  const roleCandidates = useMemberCandidates(spaceId, rolePicked ? "" : roleQuery);
  const customRoles = assignable.data?.custom ?? [];
  // #523 / ADR-190 (slice E): the assignment list now arrives with its user principals already NAMED by the
  // server (the same authorization-bounded resolution as the grant list). The old customized-only lookup is
  // gone — it left an un-customised member showing a raw sub, the last hash on this screen.
  const roleNameBySub = new Map(
    (roleAssignments.data ?? [])
      .filter((a) => a.principal.startsWith("user:"))
      .map((a) => [a.principal.replace(/^user:/, ""), a.displayName ?? null] as const),
  );
  const addRoleAssignment = () => {
    if (!roleId || !rolePicked) return;
    assignRole.mutate(
      { roleId, resourceType: "space", resourceId: spaceId, principal: `user:${rolePicked.sub}` },
      {
        onSuccess: () => { notify.success(t("toast.accessGranted")); setRolePicked(null); setRoleQuery(""); },
        onError: () => notify.error(t("toast.actionFailed")),
      },
    );
  };
  const rolePrincipalLabel = (principal: string): string => {
    if (principal.startsWith("group:")) return `${principal.replace(/^group:/, "").replace(/#member$/, "")} (${t("spaceMembers.group")})`;
    const sub = principal.replace(/^user:/, "");
    return roleNameBySub.get(sub) || sub; // server-resolved name; raw sub only for a departed/cross-tenant one
  };

  const add = () => {
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
        <Select
          value={capability}
          onChange={(v) => setCapability(v as PageRelation)}
          ariaLabel={t("spaceMembers.capability")}
          testId="space-grant-capability"
          size="sm"
          options={GRANTABLE.map((c) => ({ value: c, label: capNoun(c) }))}
        />
        <Button variant="primary" size="sm" disabled={(mode === "group" ? !groupName : !picked) || grant.isPending} onClick={add} data-testid="space-grant-add">{t("spaceMembers.add")}</Button>
      </div>

      <div className="flex flex-col gap-1" data-testid="space-grant-list">
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

      {/* #485 / #514: assign CUSTOM ROLES (defined in the tenant Roles tab) to members of THIS space —
          the assignment IA the user asked for (create in tenant, assign in space). Only shown when the
          tenant has custom resource-scope roles to assign; each assignment expands to the role's capability
          bundle server-side (manage-gated). */}
      {customRoles.length > 0 && (
        <div className="mt-8 border-t border-border pt-4" data-testid="space-role-assign">
          <h3 className="mt-0 text-sm font-medium">{t("spaceMembers.customRolesTitle")}</h3>
          <p className="mt-0 mb-3 text-sm text-fg-dim">{t("spaceMembers.customRolesBody")}</p>
          <div className="mb-4 flex items-start gap-2">
            <Select
              value={roleId}
              onChange={setRoleId}
              ariaLabel={t("spaceMembers.selectRole")}
              testId="space-role-select"
              size="sm"
              options={[
                { value: "", label: t("spaceMembers.selectRole") },
                ...customRoles.map((r) => ({ value: r.id, label: r.name })),
              ]}
            />
            <MemberSearchInput
              query={roleQuery}
              onQueryChange={setRoleQuery}
              picked={rolePicked ? { grantee: `user:${rolePicked.sub}`, label: rolePicked.label } : null}
              onPick={(c) => { setRolePicked(c ? { sub: c.sub, label: c.displayName || c.sub } : null); if (c) setRoleQuery(""); }}
              candidates={roleCandidates.data ?? []}
              placeholder={t("spaceMembers.addPlaceholder")}
              ariaLabel={t("spaceMembers.addPlaceholder")}
              inputTestId="space-role-member-input"
              listTestId="space-role-member-candidates"
              itemTestId="space-role-member-candidate"
            />
            <Button variant="primary" size="sm" disabled={!roleId || !rolePicked || assignRole.isPending} onClick={addRoleAssignment} data-testid="space-role-assign-add">{t("spaceMembers.add")}</Button>
          </div>
          <div className="flex flex-col gap-1" data-testid="space-role-assign-list">
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
