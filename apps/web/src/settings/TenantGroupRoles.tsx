import { useState } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react"; // #544: icon component, not a text glyph
import { useSession } from "../session/SessionProvider";
import { Button, IconButton } from "../ui/Button";
import { GroupPicker } from "./GroupPicker";
import { Select } from "../ui/Select";
import { notify } from "../ui/toast";
import { useRoles, useRoleAssignments, useAssignRole, useUnassignRole, useTenantGroupNames } from "../data/queries";
import { buildGroupRoleRows } from "./tenant-role-rows";

// #579: tenant roles for GROUPS. Members get their roles on their own row in the table above; a group
// has no row there — it is not a person — so it gets a section, the same split the space screen makes
// between its member list and its group mappings.
//
// The group is named, never addressed: the client sends the NAME and the server derives the FGA id
// (group-sync.ts is the single id authority). A client that builds `group:<name>#member` itself writes
// a tuple no membership points at — the assignment reports success and reaches nobody, which is
// exactly the bug #536 found on the space side.
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

      <div className="mb-3 flex flex-wrap items-end gap-3" data-testid="tenant-group-assign-form">
        <Select size="sm" value={roleId} ariaLabel={t("adminRoles.roleLabel")} testId="tenant-group-assign-role"
          options={[{ value: "", label: t("adminRoles.rolePlaceholder") }, ...tenantRoles.map((r) => ({ value: r.id, label: r.name }))]}
          onChange={setRoleId} />
        <GroupPicker value={groupName} onChange={setGroupName} known={groups.data ?? []}
          testId="tenant-group-assign-group" ariaLabel={t("adminRoles.groupLabel")} />
        <Button variant="primary" size="sm" data-testid="tenant-group-assign-add"
          disabled={!roleId || !groupName || assign.isPending}
          onClick={() => assign.mutate(
            { roleId, resourceType: "tenant", resourceId: tenantId, groupName },
            { onSuccess: () => { notify.success(t("toast.saved")); setGroupName(""); }, onError },
          )}>{t("adminRoles.assign")}</Button>
      </div>

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
                    onClick={() => unassign.mutate(h.assignmentId, { onSuccess: () => notify.success(t("toast.saved")), onError })}><X size={14} /></IconButton>
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
