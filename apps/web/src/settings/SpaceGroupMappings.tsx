import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, IconButton } from "../ui/Button";
import { ConfirmDialog } from "../ui/dialogs";
import { Input } from "../ui/Input";
import { Select } from "../ui/Select";
import { notify } from "../ui/toast";
import { useAssignableRoles, useResourceRoleMappings, useCreateRoleMapping, useDeleteRoleMapping } from "../data/queries";

// #514 / ADR-188 §8: a group→role MAPPING is configured with the same scope symmetry as an assignment —
// a mapping onto a SPACE role belongs to that space's settings, a mapping onto a tenant role to the
// tenant's. Before this, every mapping was created on the tenant Roles tab with a space picker, which put
// one space's configuration in a screen only tenant admins can open.
//
// Authorization is not widened by the move, and the server was already shaped for it: creating a mapping
// re-checks per-scope authority (roles.ts requireAssignmentAuthority — a space mapping needs `manage` on
// that space), and the filtered list answers to the same per-resource authority (requireListAuthority), so
// a space manager sees their own space's mappings and nobody else's. The roles offered come from
// `assignable-roles`, which is already scoped to this space.
export function SpaceGroupMappings({ spaceId }: { spaceId: string }) {
  const { t } = useTranslation();
  const assignable = useAssignableRoles(spaceId);
  const mappings = useResourceRoleMappings("space", spaceId);
  const createMapping = useCreateRoleMapping();
  const deleteMapping = useDeleteRoleMapping();
  const [group, setGroup] = useState("");
  const [roleId, setRoleId] = useState("");
  const [deleting, setDeleting] = useState<{ id: string; groupName: string; roleName: string } | null>(null);

  const roles = assignable.data?.custom ?? [];
  const onError = () => notify.error(t("toast.actionFailed"));

  return (
    <div className="mt-8 border-t border-border pt-4" data-testid="space-group-mappings">
      <h3 className="mt-0 text-sm font-medium">{t("adminRoles.mappingTitle")}</h3>
      <p className="mt-0 mb-2 text-xs text-fg-dim">{t("spaceMembers.mappingBody")}</p>

      <div className="mb-3 flex flex-wrap items-end gap-3" data-testid="space-mapping-form">
        <label className="flex w-56 flex-col gap-1 text-xs text-fg-dim">
          {t("adminRoles.mappingGroupLabel")}
          <Input inputSize="sm" value={group} placeholder={t("adminRoles.mappingGroupPlaceholder")}
            aria-label={t("adminRoles.mappingGroupLabel")} data-testid="space-mapping-group"
            onChange={(e) => setGroup(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-xs text-fg-dim">
          {t("adminRoles.roleLabel")}
          <Select size="sm" value={roleId} ariaLabel={t("adminRoles.roleLabel")} testId="space-mapping-role"
            options={[{ value: "", label: t("adminRoles.rolePlaceholder") }, ...roles.map((r) => ({ value: r.id, label: r.name }))]}
            onChange={setRoleId} />
        </label>
        <Button variant="primary" size="sm" data-testid="space-mapping-add"
          disabled={!group.trim() || !roleId || createMapping.isPending}
          onClick={() => createMapping.mutate(
            { groupName: group.trim(), roleId, resourceType: "space", resourceId: spaceId },
            { onSuccess: () => { notify.success(t("toast.saved")); setGroup(""); }, onError },
          )}>{t("adminRoles.mappingAdd")}</Button>
      </div>

      <div className="flex flex-col gap-1" data-testid="space-mapping-list">
        {mappings.data?.map((m) => (
          <div key={m.id} className="flex items-center gap-2 text-sm" data-testid="space-mapping-row">
            <span className="min-w-0 truncate font-medium">{m.groupName}</span>
            <span className="text-xs text-fg-dim">→ {m.roleName}</span>
            {/* #504: deleting a mapping revokes the grant it owns — red trigger AND a confirm, matching
                the tenant console's treatment of the same action. */}
            <IconButton aria-label={t("adminRoles.mappingRemove")} data-testid="space-mapping-remove" variant="danger"
              onClick={() => setDeleting({ id: m.id, groupName: m.groupName, roleName: m.roleName })}>×</IconButton>
          </div>
        ))}
        {(mappings.data?.length ?? 0) === 0 && <p className="m-0 text-xs text-fg-dim">{t("adminRoles.mappingEmpty")}</p>}
      </div>

      {/* #504: deleting a mapping revokes the role it conferred on that group — name it, danger tone,
          same treatment the tenant console gives the identical action. */}
      <ConfirmDialog
        open={deleting !== null}
        message={deleting ? t("adminRoles.mappingDeleteConfirm", { group: deleting.groupName, role: deleting.roleName }) : ""}
        confirmTestId="space-mapping-delete-confirm"
        onClose={() => setDeleting(null)}
        onConfirm={() => {
          if (!deleting) return;
          deleteMapping.mutate(deleting.id, { onSuccess: () => notify.success(t("toast.saved")), onError });
          setDeleting(null);
        }}
      />
    </div>
  );
}
