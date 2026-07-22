import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  useRoles, useCreateRole, useUpdateRole, useDeleteRole,
  useRoleAssignments, useAssignRole, useUnassignRole, useAdminSpaces,
  useTenantRoleDefaults, useSetTenantRoleDefaults, useTenantMemberCandidates,
  type RoleDef,
} from "../data/queries";
import { useSession } from "../session/SessionProvider";
import { Button, IconButton } from "../ui/Button";
import { Input } from "../ui/Input";
import { MemberSearchInput } from "../ui/MemberSearchInput";
import { Select } from "../ui/Select";
import { notify } from "../ui/toast";

// #420 / ADR-164 increment 5: the custom-role manager (tenant-admin console). Definitions =
// named bundles of the atomic capabilities; assignments expand to fixed FGA tuples server-side.
// The UI is convenience only — the server enforces tenant-admin + the customRoles entitlement on
// every write (a non-entitled plan sees the built-ins and gets the 403 upsell on create).
const CAPABILITIES = ["view", "comment", "edit", "publish", "delete", "share", "settings", "moderate"] as const;
// #445 / ADR-171: the TENANT-scope vocabulary (tenant actions; mutually exclusive with the above).
const TENANT_CAPABILITIES = ["createSpaces"] as const;

// #420`disabled` renders the SAME control read-only, so a built-in role is shown as the very
// checkbox grid you would use to build a custom one — the vocabulary and layout match instead of the
// old "cap · cap · cap" text, and what a role can do reads the same way everywhere.
function CapabilityPicker({ value, onChange, idPrefix, list, disabled = false }: { value: string[]; onChange?: (caps: string[]) => void; idPrefix: string; list: readonly string[]; disabled?: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1">
      {list.map((c) => (
        <label key={c} className={`flex items-center gap-1.5 text-sm${disabled ? " text-fg-dim" : ""}`}>
          <input
            type="checkbox"
            data-testid={`${idPrefix}-cap-${c}`}
            checked={value.includes(c)}
            disabled={disabled}
            onChange={disabled ? undefined : (e) => onChange?.(e.target.checked ? [...value, c] : value.filter((x) => x !== c))}
            readOnly={disabled}
          />
          <span>{t(`adminRoles.cap.${c}`)}</span>
        </label>
      ))}
    </div>
  );
}

function RoleEditor({ initial, onSave, onCancel, pending, scopeSelectable = false }: {
  initial: { name: string; capabilities: string[]; scope: "resource" | "tenant" };
  onSave: (v: { name: string; capabilities: string[]; scope: "resource" | "tenant" }) => void;
  onCancel?: () => void;
  pending: boolean;
  scopeSelectable?: boolean; // scope is fixed after creation (#445)
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(initial.name);
  const [caps, setCaps] = useState<string[]>(initial.capabilities);
  const [scope, setScope] = useState<"resource" | "tenant">(initial.scope);
  return (
    <div className="flex flex-col gap-2 rounded-md border border-border p-3">
      <div className="flex items-center gap-2">
        <Input inputSize="sm" className="max-w-xs" value={name} placeholder={t("adminRoles.namePlaceholder")}
          aria-label={t("adminRoles.nameLabel")} data-testid="role-name-input" onChange={(e) => setName(e.target.value)} />
        {scopeSelectable && (
          <Select size="sm" value={scope} ariaLabel={t("adminRoles.scopeLabel")} testId="role-scope"
            options={[
              { value: "resource", label: t("adminRoles.scopeResource") },
              { value: "tenant", label: t("adminRoles.scopeTenant") },
            ]}
            onChange={(v) => { setScope(v as "resource" | "tenant"); setCaps([]); }} />
        )}
      </div>
      <CapabilityPicker value={caps} onChange={setCaps} idPrefix="role" list={scope === "tenant" ? TENANT_CAPABILITIES : CAPABILITIES} />
      <div className="flex gap-2">
        <Button variant="primary" size="sm" data-testid="role-save" disabled={pending || !name.trim() || caps.length === 0}
          onClick={() => onSave({ name: name.trim(), capabilities: caps, scope })}>{t("common.save")}</Button>
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
  // #420the member field is a name search; `assignSub` stays the resolved sub the server wants,
  // and typing a raw sub still works (the picker assists, it never gates — ADR-161).
  const [memberQuery, setMemberQuery] = useState("");
  const [pickedMember, setPickedMember] = useState<{ grantee: string; label: string } | null>(null);
  const memberCandidates = useTenantMemberCandidates(memberQuery);
  // #445: default tenant-role presets (CE) + the tenant scope for custom-role assignment.
  const { tenantId } = useSession();
  const defaults = useTenantRoleDefaults();
  const setDefaults = useSetTenantRoleDefaults();
  const assignRole = (roles.data?.custom ?? []).find((r) => r.id === assignRoleId);
  const assignScope: "space" | "tenant" = assignRole?.scope === "tenant" ? "tenant" : "space";
  const assignResourceId = assignScope === "tenant" ? tenantId : assignSpaceId;
  const assignments = useRoleAssignments(assignScope, assignResourceId);

  const onError = (e: unknown) => {
    const status = (e as { status?: number })?.status;
    notify.error(status === 403 ? t("adminRoles.notEntitled") : status === 409 ? t("adminRoles.conflict") : t("toast.actionFailed"));
  };

  return (
    <div className="max-w-[860px] p-6" data-testid="admin-roles">
      <h2 className="mt-0">{t("adminRoles.title")}</h2>

      {/* #445/ #469: ONE place answers "what can this role do", and every built-in role reads the
          SAME way — a bold name + a CapabilityPicker — whether it is tenant- or resource-scoped. The
          tenant-level `createSpaces` capability lives IN that list. member's picker is the only editable
          cell: its createSpaces box IS the tenant#space_creator wildcard (drives setDefaults). admin's is a
          read-only picker with createSpaces checked (the model's `or admin`). This OVERTURNS the ADR-171
          addendum note that admin had to be plain text to avoid a lone disabled checkbox reading "broken":
          now that EVERY built-in is a uniform read-only picker, a disabled admin cell reads as consistent,
          not broken. UI only — the member toggle drives the very same wildcard through the unchanged endpoint. */}
      <h3 className="text-sm font-medium">{t("adminRoles.builtInTenantTitle")}</h3>
      <div className="mb-4 flex flex-col gap-2" data-testid="builtin-tenant-roles">
        <div className="flex flex-col gap-1" data-testid="builtin-role-member">
          <span className="text-sm font-medium">member</span>
          <CapabilityPicker
            value={(defaults.data?.member.createSpaces ?? true) ? ["createSpaces"] : []}
            idPrefix="builtin-member"
            list={TENANT_CAPABILITIES}
            disabled={defaults.isLoading || setDefaults.isPending}
            onChange={(caps) => setDefaults.mutate(caps.includes("createSpaces"), {
              onSuccess: () => notify.success(t("toast.saved")),
              onError,
            })}
          />
        </div>
        <div className="flex flex-col gap-1" data-testid="builtin-role-admin">
          <span className="text-sm font-medium">admin</span>
          <CapabilityPicker value={["createSpaces"]} idPrefix="builtin-admin" list={TENANT_CAPABILITIES} disabled />
        </div>
      </div>

      {/* Built-in RESOURCE roles: virtual, read-only — shown so the picker vocabulary is uniform. */}
      <h3 className="text-sm font-medium">{t("adminRoles.builtInResourceTitle")}</h3>
      <div className="mb-4 flex flex-col gap-2" data-testid="builtin-roles">
        {(roles.data?.builtIn ?? []).map((r) => (
          <div key={r.name} className="flex flex-col gap-1">
            <span className="text-sm font-medium">{r.name}</span>
            <CapabilityPicker value={r.capabilities} idPrefix={`builtin-${r.name}`} list={CAPABILITIES} disabled />
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
              onSave={(v) => updateRole.mutate({ id: r.id, name: v.name, capabilities: v.capabilities }, {
                onSuccess: () => { notify.success(t("toast.saved")); setEditing(null); },
                onError,
              })} />
          ) : (
            <div key={r.id} className="flex items-center gap-2 text-sm" data-testid="custom-role-row">
              <span className="font-medium">{r.name}</span>
              {r.scope === "tenant" && <span className="rounded bg-bg-subtle px-1 text-[10px] uppercase tracking-wide text-fg-dim">{t("adminRoles.scopeTenant")}</span>}
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
        <RoleEditor initial={{ name: "", capabilities: [], scope: "resource" }} scopeSelectable pending={createRole.isPending}
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
      {/* #420each control says what it is. Two unlabelled dropdowns side by side gave no way
          to tell which one was the role and which the space; and the member field asked for a "sub",
          an internal identifier nobody outside the code knows — it is a name search now, resolving to
          the same `user:<sub>` principal the server has always expected. */}
      <div className="mb-3 flex flex-wrap items-end gap-3" data-testid="assign-form">
        <label className="flex flex-col gap-1 text-xs text-fg-dim">
          {t("adminRoles.roleLabel")}
          <Select size="sm" value={assignRoleId} ariaLabel={t("adminRoles.roleLabel")} testId="assign-role"
            options={(roles.data?.custom ?? []).map((r) => ({ value: r.id, label: r.name }))}
            onChange={setAssignRoleId} />
        </label>
        {assignScope === "space" && (
          <label className="flex flex-col gap-1 text-xs text-fg-dim">
            {t("adminRoles.spaceLabel")}
            <Select size="sm" value={assignSpaceId} ariaLabel={t("adminRoles.spaceLabel")} testId="assign-space"
              options={(spaces.data ?? []).map((s) => ({ value: s.id, label: s.name || s.id }))}
              onChange={setAssignSpaceId} />
          </label>
        )}
        {assignScope === "tenant" && <span className="pb-1.5 text-xs text-fg-dim" data-testid="assign-tenant-note">{t("adminRoles.assignTenantScope")}</span>}
        <label className="flex w-64 flex-col gap-1 text-xs text-fg-dim">
          {t("adminRoles.subLabel")}
          <MemberSearchInput
            inputSize="sm"
            query={memberQuery}
            onQueryChange={(q) => { setMemberQuery(q); setAssignSub(q.trim()); }}
            picked={pickedMember}
            onPick={(c) => {
              setPickedMember(c ? { grantee: c.sub, label: c.displayName || c.sub } : null);
              setAssignSub(c ? c.sub : "");
              if (c) setMemberQuery("");
            }}
            candidates={memberCandidates.candidates}
            placeholder={t("adminRoles.subPlaceholder")}
            ariaLabel={t("adminRoles.subLabel")}
            inputTestId="assign-sub"
            listTestId="assign-sub-list"
            itemTestId="assign-sub-item"
          />
        </label>
        <Button variant="primary" size="sm" data-testid="assign-add"
          disabled={!assignRoleId || !assignResourceId || !assignSub.trim() || assign.isPending}
          onClick={() => assign.mutate({ roleId: assignRoleId, resourceType: assignScope, resourceId: assignResourceId, principal: `user:${assignSub.trim()}` }, {
            onSuccess: () => { notify.success(t("toast.saved")); setAssignSub(""); setMemberQuery(""); setPickedMember(null); },
            onError,
          })}>{t("adminRoles.assign")}</Button>
      </div>
      {assignResourceId && (
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
