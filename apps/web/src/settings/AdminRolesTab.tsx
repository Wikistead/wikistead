import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  useRoles, useCreateRole, useUpdateRole, useDeleteRole,
  useRoleAssignments, useAssignRole, useUnassignRole, useAdminSpaces,
  type RoleDef,
} from "../data/queries";
import { Button, IconButton } from "../ui/Button";
import { Input } from "../ui/Input";
import { Select } from "../ui/Select";
import { notify } from "../ui/toast";

// #420 / ADR-164 increment 5: the custom-role manager (tenant-admin console). Definitions =
// named bundles of the atomic capabilities; assignments expand to fixed FGA tuples server-side.
// The UI is convenience only — the server enforces tenant-admin + the customRoles entitlement on
// every write (a non-entitled plan sees the built-ins and gets the 403 upsell on create).
const CAPABILITIES = ["view", "comment", "edit", "publish", "delete", "share", "settings", "moderate"] as const;

function CapabilityPicker({ value, onChange, idPrefix }: { value: string[]; onChange: (caps: string[]) => void; idPrefix: string }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1">
      {CAPABILITIES.map((c) => (
        <label key={c} className="flex items-center gap-1.5 text-sm">
          <input
            type="checkbox"
            data-testid={`${idPrefix}-cap-${c}`}
            checked={value.includes(c)}
            onChange={(e) => onChange(e.target.checked ? [...value, c] : value.filter((x) => x !== c))}
          />
          <span>{t(`adminRoles.cap.${c}`)}</span>
        </label>
      ))}
    </div>
  );
}

function RoleEditor({ initial, onSave, onCancel, pending }: {
  initial: { name: string; capabilities: string[] };
  onSave: (v: { name: string; capabilities: string[] }) => void;
  onCancel?: () => void;
  pending: boolean;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(initial.name);
  const [caps, setCaps] = useState<string[]>(initial.capabilities);
  return (
    <div className="flex flex-col gap-2 rounded-md border border-border p-3">
      <Input inputSize="sm" className="max-w-xs" value={name} placeholder={t("adminRoles.namePlaceholder")}
        aria-label={t("adminRoles.nameLabel")} data-testid="role-name-input" onChange={(e) => setName(e.target.value)} />
      <CapabilityPicker value={caps} onChange={setCaps} idPrefix="role" />
      <div className="flex gap-2">
        <Button variant="primary" size="sm" data-testid="role-save" disabled={pending || !name.trim() || caps.length === 0}
          onClick={() => onSave({ name: name.trim(), capabilities: caps })}>{t("common.save")}</Button>
        {onCancel && <Button variant="default" size="sm" onClick={onCancel}>{t("common.cancel")}</Button>}
      </div>
    </div>
  );
}

export function AdminRolesTab() {
  const { t } = useTranslation();
  const roles = useRoles();
  const createRole = useCreateRole();
  const updateRole = useUpdateRole();
  const deleteRole = useDeleteRole();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<RoleDef | null>(null);

  // Assignment panel: pick a custom role + a space + a member sub → expand. Space-scope only in
  // the v1 console (page-scope assignment is reachable via the API; a page picker is a follow-up).
  const spaces = useAdminSpaces();
  const assign = useAssignRole();
  const unassign = useUnassignRole();
  const [assignRoleId, setAssignRoleId] = useState("");
  const [assignSpaceId, setAssignSpaceId] = useState("");
  const [assignSub, setAssignSub] = useState("");
  const assignments = useRoleAssignments("space", assignSpaceId);

  const onError = (e: unknown) => {
    const status = (e as { status?: number })?.status;
    notify.error(status === 403 ? t("adminRoles.notEntitled") : status === 409 ? t("adminRoles.conflict") : t("toast.actionFailed"));
  };

  return (
    <div className="max-w-[860px] p-6" data-testid="admin-roles">
      <h2 className="mt-0">{t("adminRoles.title")}</h2>
      <p className="mt-0 mb-4 text-sm text-fg-dim">{t("adminRoles.body")}</p>

      {/* Built-in roles: virtual, read-only — shown so the picker vocabulary is uniform. */}
      <h3 className="text-sm font-medium">{t("adminRoles.builtInTitle")}</h3>
      <div className="mb-4 flex flex-col gap-1" data-testid="builtin-roles">
        {(roles.data?.builtIn ?? []).map((r) => (
          <div key={r.name} className="flex items-baseline gap-2 text-sm">
            <span className="font-medium">{r.name}</span>
            <span className="text-xs text-fg-dim">{r.capabilities.join(" · ")}</span>
            <span className="text-[10px] uppercase tracking-wide text-fg-dim">{t("adminRoles.builtIn")}</span>
          </div>
        ))}
      </div>

      {/* Custom roles (EE): create / edit / delete. */}
      <h3 className="text-sm font-medium">{t("adminRoles.customTitle")}</h3>
      <div className="mb-2 flex flex-col gap-2" data-testid="custom-roles">
        {(roles.data?.custom ?? []).map((r) =>
          editing?.id === r.id ? (
            <RoleEditor key={r.id} initial={editing} pending={updateRole.isPending}
              onCancel={() => setEditing(null)}
              onSave={(v) => updateRole.mutate({ id: r.id, ...v }, {
                onSuccess: () => { notify.success(t("toast.saved")); setEditing(null); },
                onError,
              })} />
          ) : (
            <div key={r.id} className="flex items-center gap-2 text-sm" data-testid="custom-role-row">
              <span className="font-medium">{r.name}</span>
              <span className="min-w-0 flex-1 truncate text-xs text-fg-dim">{r.capabilities.join(" · ")}</span>
              <Button variant="ghost" size="sm" data-testid="role-edit" onClick={() => setEditing(r)}>{t("common.edit")}</Button>
              <IconButton aria-label={t("adminRoles.delete")} data-testid="role-delete"
                onClick={() => deleteRole.mutate(r.id, { onSuccess: () => notify.success(t("toast.saved")), onError })}>×</IconButton>
            </div>
          ),
        )}
        {(roles.data?.custom.length ?? 0) === 0 && <p className="m-0 text-xs text-fg-dim">{t("adminRoles.customEmpty")}</p>}
      </div>
      {creating ? (
        <RoleEditor initial={{ name: "", capabilities: [] }} pending={createRole.isPending}
          onCancel={() => setCreating(false)}
          onSave={(v) => createRole.mutate(v, {
            onSuccess: () => { notify.success(t("toast.saved")); setCreating(false); },
            onError,
          })} />
      ) : (
        <Button variant="default" size="sm" data-testid="role-create" onClick={() => setCreating(true)}>{t("adminRoles.create")}</Button>
      )}

      {/* Assignments: role → space → member. The server expands to the fixed FGA tuples (with the
         reference-counted unassign); provenance shows WHO holds WHICH role. */}
      <h3 className="mt-8 text-sm font-medium">{t("adminRoles.assignTitle")}</h3>
      <p className="mt-0 mb-2 text-xs text-fg-dim">{t("adminRoles.assignBody")}</p>
      <div className="mb-3 flex flex-wrap items-center gap-2" data-testid="assign-form">
        <Select size="sm" value={assignRoleId} ariaLabel={t("adminRoles.roleLabel")} testId="assign-role"
          options={(roles.data?.custom ?? []).map((r) => ({ value: r.id, label: r.name }))}
          onChange={setAssignRoleId} />
        <Select size="sm" value={assignSpaceId} ariaLabel={t("adminRoles.spaceLabel")} testId="assign-space"
          options={(spaces.data ?? []).map((s) => ({ value: s.id, label: s.name || s.id }))}
          onChange={setAssignSpaceId} />
        <Input inputSize="sm" className="w-56" value={assignSub} placeholder={t("adminRoles.subPlaceholder")}
          aria-label={t("adminRoles.subLabel")} data-testid="assign-sub" onChange={(e) => setAssignSub(e.target.value)} />
        <Button variant="primary" size="sm" data-testid="assign-add"
          disabled={!assignRoleId || !assignSpaceId || !assignSub.trim() || assign.isPending}
          onClick={() => assign.mutate({ roleId: assignRoleId, resourceType: "space", resourceId: assignSpaceId, principal: `user:${assignSub.trim()}` }, {
            onSuccess: () => { notify.success(t("toast.saved")); setAssignSub(""); },
            onError,
          })}>{t("adminRoles.assign")}</Button>
      </div>
      {assignSpaceId && (
        <div className="flex flex-col gap-1" data-testid="assignment-list">
          {assignments.data?.map((a) => (
            <div key={a.id} className="flex items-center gap-2 text-sm" data-testid="assignment-row">
              <span className="min-w-0 flex-1 truncate">{a.principal.replace(/^user:/, "")}</span>
              <span className="text-xs text-fg-dim">{a.roleName}</span>
              <IconButton aria-label={t("adminRoles.unassign")} data-testid="assignment-remove"
                onClick={() => unassign.mutate(a.id, { onSuccess: () => notify.success(t("toast.saved")), onError })}>×</IconButton>
            </div>
          ))}
          {(assignments.data?.length ?? 0) === 0 && <p className="m-0 text-xs text-fg-dim">{t("adminRoles.assignEmpty")}</p>}
        </div>
      )}
    </div>
  );
}
