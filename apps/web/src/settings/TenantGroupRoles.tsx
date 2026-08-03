import { useState } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react"; // #544: icon component, not a text glyph
import { useSession } from "../session/SessionProvider";
import { IconButton } from "../ui/Button";
import { GranteeRoleForm } from "./GranteeRoleForm";
import { notify } from "../ui/toast";
import { useRoles, useRoleAssignments, useAssignRole, useUnassignRole, useTenantGroupNames } from "../data/queries";
import { buildGroupRoleRows } from "./tenant-role-rows";
import { notifyRevokeOutcome, notifyRevokeError } from "./revoke-feedback";

// #579: tenant roles for GROUPS. Members get their roles on their own row in the table above; a group
// has no row there — it is not a person — so it gets a section, the same split the space screen makes
// between its member list and its group mappings.
//
// The group is named, never addressed: the client sends the NAME and the server derives the FGA id
// (group-sync.ts is the single id authority). A client that builds `group:<name>#member` itself writes
// a tuple no membership points at — the assignment reports success and reaches nobody, which is
// exactly the bug #536 found on the space side.
// SUPERSEDED 2026-08-03 (#579 ruling): the sentence that used to stand here said a group's tenant roles
// are ADDITIVE, and that is no longer true — was ruled, and the tenant assign
// path now converges a principal to one role (a71d8100). The chips below are therefore drawing a set
// that cannot exist, and this whole section is being folded into the member table: people and groups in
// one list, one control each. That slice is not landed yet because removing this section without the
// merged search would take away the only way to name a group nobody has signed in with (#578), so the
// section stays for now — with its premise corrected rather than left standing as a lie a reader would
// take at face value.
export function TenantGroupRoles() {
  const { t } = useTranslation();
  const { tenantId } = useSession();
  const roles = useRoles();
  const assignments = useRoleAssignments("tenant", tenantId);
  const groups = useTenantGroupNames();
  const assign = useAssignRole();
  const unassign = useUnassignRole();
  const [roleId, setRoleId] = useState("");
  const [groupName, setGroupName] = useState("");

  const tenantRoles = (roles.data?.custom ?? []).filter((r) => r.scope === "tenant");
  const rows = buildGroupRoleRows(assignments.data ?? [], t("spaceMembers.unknownGroup"), t("spaceMembers.group"), t("spaceMembers.groupNotSeen"));
  // A tenant with no groups and nothing assigned would get an empty box on every visit. Stay out of
  // the way — but keep the section as soon as either side exists, so an existing assignment is never
  // hidden just because the IdP stopped sending the group.
  if (tenantRoles.length === 0 && rows.length === 0) return null;

  const onError = () => notify.error(t("toast.actionFailed"));

  return (
    <section className="mb-8" data-testid="tenant-group-roles">
      <h3 className="mt-0 text-sm font-medium">{t("adminRoles.groupAssignTitle")}</h3>
      <p className="mt-0 mb-2 text-xs text-fg-dim">{t("adminRoles.groupAssignBody")}</p>
      {/* #579 bounce ②, ruled by ADR-201: the picker holds custom roles and no tiers, and it now says
          so instead of leaving the reader to infer it from an absence. `member` is universal (everyone
          already has it, so conferring it by group means nothing) and `admin` is granted per person on
          purpose — ADR-201 retired group-conferred admin so that the tenant can always read off WHO
          holds it and revoke without going to the IdP. The space screen does offer built-ins to a
          group, which is why the difference needs a sentence here rather than silence. */}
      <p className="mt-0 mb-2 text-xs text-fg-dim" data-testid="tenant-group-tiers-note">{t("adminRoles.groupTiersNote")}</p>

      {/* #578 bounce ③: the same add-flow component the space screen uses. Only two things differ, and
          both are arguments: this surface confers TENANT-scope custom roles, and it offers groups only
          — people get their tenant roles on their own row, which #579 ruled and pins. */}
      <GranteeRoleForm
        testId="tenant-group-assign"
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
        knownGroups={groups.data ?? []}
        roleOptions={[{ value: "", label: t("adminRoles.rolePlaceholder") }, ...tenantRoles.map((r) => ({ value: r.id, label: r.name }))]}
        role={roleId}
        onRoleChange={setRoleId}
        pending={assign.isPending || !roleId}
        onAdd={() => assign.mutate(
          { roleId, resourceType: "tenant", resourceId: tenantId, groupName },
          { onSuccess: () => { notify.success(t("toast.saved")); setGroupName(""); }, onError },
        )}
      />

      <div className="flex flex-col gap-1" data-testid="tenant-group-role-list">
        {rows.map((r) => (
          <div key={r.principal} className="flex items-center gap-2 text-sm" data-testid="tenant-group-role-row">
            <span className="min-w-0 flex-1 truncate">{r.label}</span>
            {r.held.map((h) => (
              <span key={h.assignmentId} className="inline-flex items-center gap-1 text-xs text-fg-dim">
                {h.roleName}
                {/* a mapping-owned assignment is machine state (ADR-183 §1) — the server refuses to
                    unassign it, so the affordance is not offered either */}
                {!h.managed && (
                  <IconButton aria-label={t("adminRoles.unassign")} data-testid="tenant-group-role-remove" variant="danger"
                    onClick={() => unassign.mutate(h.assignmentId, { onSuccess: (data) => notifyRevokeOutcome(t, data), onError: (err) => notifyRevokeError(t, err) })}><X size={14} /></IconButton>
                )}
              </span>
            ))}
          </div>
        ))}
        {rows.length === 0 && <p className="m-0 text-xs text-fg-dim">{t("adminRoles.groupAssignEmpty")}</p>}
      </div>
    </section>
  );
}
