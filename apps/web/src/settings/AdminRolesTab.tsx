import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  useRoles, useCreateRole, useUpdateRole, useDeleteRole,
  useRoleAssignments, useAssignRole, useUnassignRole, useAdminSpaces,
  useTenantRoleDefaults, useSetTenantRoleDefaults, useTenantMemberCandidates,
  useRoleMappings, useCreateRoleMapping, useDeleteRoleMapping,
  useDefaultRole, useSetDefaultRole,
} from "../data/queries";
import { useSession } from "../session/SessionProvider";
import { Button, IconButton } from "../ui/Button";
import { ConfirmDialog } from "../ui/dialogs"; // #504: deleting a role is irreversible — confirm first
import { Input } from "../ui/Input";
import { MemberSearchInput } from "../ui/MemberSearchInput";
import { RadioGroup } from "../ui/RadioGroup";
import { Select } from "../ui/Select";
import { notify } from "../ui/toast";
import { Pencil, X, ArrowRight } from "lucide-react"; // #544: icon components, not text glyphs (font fallback squashed them)

// #420 / ADR-164 increment 5: the custom-role manager (tenant-admin console). Definitions =
// named bundles of the atomic capabilities; assignments expand to fixed FGA tuples server-side.
// The UI is convenience only — the server enforces tenant-admin + the customRoles entitlement on
// every write (a non-entitled plan sees the built-ins and gets the 403 upsell on create).
const CAPABILITIES = ["view", "comment", "edit", "publish", "delete", "share", "settings", "moderate"] as const;
// #445 / ADR-171: the TENANT-scope vocabulary (tenant actions; mutually exclusive with the above).
// #496 / ADR-181: `issueApiKeys` (the api_key_issue relation) joins the tenant vocabulary, so it shows
// up BOTH in the built-in member toggle below and in the custom tenant-role editor — the ADR's "one
// screen configures issuance". The old /admin/api two-choice policy selector is gone with the enum.
const TENANT_CAPABILITIES = ["createSpaces", "issueApiKeys"] as const;

// #536gave every row a scope badge because the sections it sat in were not readable as sections.
// #581 fixes the sections instead and drops the badge here: where POSITION carries the information,
// repeating it on every row is noise the user asked us to remove. The badge is still available —
// `scope` is optional now — for a surface that mixes scopes in one list (a search result, a member
// row's chips), where position says nothing. "BUILT-IN" always stays: no position implies it.
function RoleBadges({ scope, builtIn = false }: { scope?: "resource" | "tenant"; builtIn?: boolean }) {
  const { t } = useTranslation();
  return (
    <>
      {scope && (
        <span className="rounded bg-panel-2 px-1 text-[10px] uppercase tracking-wide text-fg-dim" data-testid="role-scope-badge">
          {t(scope === "tenant" ? "adminRoles.scopeTenant" : "adminRoles.scopeResource")}
        </span>
      )}
      {builtIn && <span className="rounded border border-border px-1 text-[10px] uppercase tracking-wide text-fg-dim" data-testid="role-builtin-badge">{t("adminRoles.builtIn")}</span>}
    </>
  );
}

// #420`disabled` renders the SAME control read-only, so a built-in role is shown as the very
// checkbox grid you would use to build a custom one — the vocabulary and layout match instead of the
// old "cap · cap · cap" text, and what a role can do reads the same way everywhere.
// #445`lockLast` keeps a role from losing its LAST capability — the sole checked box renders
// disabled (with a title explaining why), mirroring the server's non-empty validation (`role-save`'s
// existing constraint) instead of letting the toggle round-trip to a 400.
function CapabilityPicker({ value, onChange, idPrefix, list, disabled = false, lockLast = false }: { value: string[]; onChange?: (caps: string[]) => void; idPrefix: string; list: readonly string[]; disabled?: boolean; lockLast?: boolean }) {
  const { t } = useTranslation();
  const lastLocked = lockLast && value.length === 1;
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1">
      {list.map((c) => {
        const itemLocked = lastLocked && value.includes(c);
        const itemDisabled = disabled || itemLocked;
        return (
          <label key={c} className={`flex items-center gap-1.5 text-sm${disabled ? " text-fg-dim" : ""}`} data-tip={itemLocked ? t("adminRoles.lastCap") : undefined}>
            <input
              type="checkbox"
              data-testid={`${idPrefix}-cap-${c}`}
              checked={value.includes(c)}
              disabled={itemDisabled}
              onChange={itemDisabled ? undefined : (e) => onChange?.(e.target.checked ? [...value, c] : value.filter((x) => x !== c))}
              readOnly={itemDisabled}
            />
            <span>{t(`adminRoles.cap.${c}`)}</span>
          </label>
        );
      })}
    </div>
  );
}

// #580: the scope is CHOSEN, and it is the first thing on the form.
//
// #536removed a scope <Select> nobody could find and derived the scope from the boxes instead —
// which fixed the hidden control and created a new problem the user then hit: you cannot tell which
// kind of role you are making until you have already ticked something, and both vocabularies sit in
// one undifferentiated grid until then. The answer is not to bring back the hidden Select: the choice
// is made visible, as two segments, with a default, so the form always says what it is building.
//
// The capability list then follows the segment, which is what makes a mixed role UNBUILDABLE rather
// than merely refused at save — the mixed-state hint has nothing left to warn about. The server's
// exclusivity check stays exactly where it was (two layers; the UI is convenience, ADR-171 §445).
function RoleEditor({ onSave, onCancel, pending }: {
  onSave: (v: { name: string; capabilities: string[]; scope: "resource" | "tenant" }) => void;
  onCancel?: () => void;
  pending: boolean;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [scope, setScope] = useState<"resource" | "tenant">("resource");
  const [caps, setCaps] = useState<string[]>([]);
  const list = scope === "tenant" ? TENANT_CAPABILITIES : CAPABILITIES;
  // switching scope drops what was ticked: keeping it would rebuild the mixed role this removes, and
  // a capability from the other vocabulary is not "the same choice" in the new scope.
  const pickScope = (next: "resource" | "tenant") => { setScope(next); setCaps([]); };
  // #580 review 2: "the form says what it is building" only holds if the form is ON SCREEN.
  // /admin/roles is a long page, so the trigger sits near the bottom edge and the form opened BELOW
  // it — measured at top=759 on a 720px viewport, i.e. the segments were off screen at the moment
  // they were supposed to be doing their job. Opening scrolls the form into view.
  const formRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => { formRef.current?.scrollIntoView({ block: "center" }); }, []);
  return (
    <div ref={formRef} className="flex flex-col gap-2 rounded-md border border-border p-3">
      <Input inputSize="sm" className="max-w-xs" value={name} placeholder={t("adminRoles.namePlaceholder")}
        aria-label={t("adminRoles.nameLabel")} data-testid="role-name-input" onChange={(e) => setName(e.target.value)} />
      <div className="flex flex-col gap-1">
        <span className="text-xs text-fg-dim">{t("adminRoles.scopeQuestion")}</span>
        {/* #587: the DS segmented radiogroup, not a hand-rolled one. #580 built this by hand and had to
            add roving tabindex and arrow keys by hand too, one review later; the component has
            carried both since #389. The wrapper keeps the container test-id the #580 pins use. */}
        <span data-testid="role-scope-segments" className="w-fit">
          <RadioGroup
            variant="segmented"
            value={scope}
            onChange={(v) => pickScope(v as "resource" | "tenant")}
            ariaLabel={t("adminRoles.scopeQuestion")}
            testId="role-scope"
            options={[
              { value: "resource", label: t("adminRoles.scopeResource") },
              { value: "tenant", label: t("adminRoles.scopeTenant") },
            ]}
          />
        </span>
      </div>
      <CapabilityPicker value={caps} onChange={setCaps} idPrefix="role" list={list} />
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
  // #445the full edit form is gone — capabilities toggle INLINE (per-op commit) and only the
  // NAME keeps a small affordance (pencil → inline input).
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  // #504: deleting a role is irreversible (its assignments go with it) — red trigger + confirm.
  const [deletingRole, setDeletingRole] = useState<{ id: string; name: string } | null>(null);

  // #514 slice 4: the assignment panel moved off this tab (see the note in the JSX). `spaces` stays —
  // the group→role MAPPING form below still needs a space picker for space-scope mappings.
  const spaces = useAdminSpaces();
  // #445: default tenant-role presets (CE).
  const { tenantId } = useSession();
  const defaults = useTenantRoleDefaults();
  const setDefaults = useSetTenantRoleDefaults();

  // #497 / ADR-183: declarative group → role mappings. A mapping owns a group-principal role
  // assignment; group members resolve live at check time (no reconcile). The role's scope decides
  // the target (tenant → this tenant; space → a picked space), mirroring the assignment form.
  const mappings = useRoleMappings();
  // #497: "· <scope>" for a mapping row — the tenant, or the space it targets by NAME (resolved from the
  // space list already loaded above). Unknown space → no suffix, never the uuid.
  const mappingScope = (m: { resourceType: string; resourceId: string }): string => {
    if (m.resourceType === "tenant") return ` · ${t("adminRoles.scopeTenant")}`;
    const space = (spaces.data ?? []).find((s) => s.id === m.resourceId);
    return space ? ` · ${space.name || space.id}` : "";
  };
  const createMapping = useCreateRoleMapping();
  const deleteMapping = useDeleteRoleMapping();
  const [mapGroup, setMapGroup] = useState("");
  const [mapRoleId, setMapRoleId] = useState("");
  const [mapSpaceId, setMapSpaceId] = useState("");
  const [deletingMapping, setDeletingMapping] = useState<{ id: string; groupName: string; roleName: string } | null>(null);
  const mapRole = (roles.data?.custom ?? []).find((r) => r.id === mapRoleId);
  const mapScope: "space" | "tenant" = mapRole?.scope === "tenant" ? "tenant" : "space";
  const mapResourceId = mapScope === "tenant" ? tenantId : mapSpaceId;

  // #497 / ADR-183 §3: the tenant default role — a tenant-scope custom role conferred on any member
  // no mapping matches (applied at their next login). Only tenant-scope roles are eligible.
  const defaultRole = useDefaultRole();
  const setDefaultRole = useSetDefaultRole();
  const tenantRoles = (roles.data?.custom ?? []).filter((r) => r.scope === "tenant");

  const onError = (e: unknown) => {
    const status = (e as { status?: number })?.status;
    notify.error(status === 403 ? t("adminRoles.notEntitled") : status === 409 ? t("adminRoles.conflict") : t("toast.actionFailed"));
  };

  // #536④: one renderer for a custom-role row, used by BOTH scope sections (the row itself is
  // scope-agnostic; only which section it sits in changed).
  const renderCustomRole = (r: { id: string; name: string; capabilities: string[]; scope: string }) => {
    const commitRename = () => {
      if (renamingId !== r.id) return; // Enter already committed; the trailing blur is a no-op
      const v = renameValue.trim();
      setRenamingId(null);
      if (!v || v === r.name) return;
      updateRole.mutate({ id: r.id, name: v, capabilities: r.capabilities }, {
        onSuccess: () => notify.success(t("toast.saved")),
        onError,
      });
    };
    return (
      <div key={r.id} className="flex flex-col gap-1" data-testid="custom-role-row">
        <div className="flex items-center gap-2 text-sm">
          {renamingId === r.id ? (
            <Input inputSize="sm" className="max-w-xs" value={renameValue} autoFocus
              aria-label={t("adminRoles.nameLabel")} data-testid="role-rename-input"
              onChange={(e) => setRenameValue(e.target.value)}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitRename();
                else if (e.key === "Escape") setRenamingId(null);
              }} />
          ) : (
            <>
              <span className="font-medium">{r.name}</span>
              <RoleBadges />
              <IconButton aria-label={t("adminRoles.rename")} data-tip={t("adminRoles.rename")} data-testid="role-rename"
                onClick={() => { setRenamingId(r.id); setRenameValue(r.name); }}><Pencil size={14} /></IconButton>
            </>
          )}
          <span className="flex-1" />
          {/* #504: red at rest + confirm-before-delete (irreversible — assignments die with it) */}
          <IconButton aria-label={t("adminRoles.delete")} data-testid="role-delete" variant="danger"
            onClick={() => setDeletingRole({ id: r.id, name: r.name })}><X size={14} /></IconButton>
        </div>
        <CapabilityPicker
          value={r.capabilities}
          idPrefix="custom"
          list={r.scope === "tenant" ? TENANT_CAPABILITIES : CAPABILITIES}
          disabled={updateRole.isPending}
          lockLast
          onChange={(caps) => {
            if (caps.length === 0) return; // belt + braces under lockLast — never PUT an empty bundle
            updateRole.mutate({ id: r.id, name: r.name, capabilities: caps }, {
              onSuccess: () => notify.success(t("toast.saved")),
              onError,
            });
          }}
        />
      </div>
    );
  };

  return (
    <div className="max-w-[860px] p-6" data-testid="admin-roles">
      <h2 className="mt-0">{t("adminRoles.title")}</h2>

      {/* #536(user re-ruling) +④: ONE set of roles, presented in TWO scope sections —
          "Tenant" above, "Space / Page" below (the ruling: tenant roles and resource roles mixed in one
          flat list read as a jumble; the dividing axis is SCOPE, not built-in/custom). Within each
          section the order is built-in → custom (DOM-pinned). What each row keeps:
          - #445/ #469: every role reads the SAME way — bold name + a CapabilityPicker; built-ins
            are the read-only version of the very control custom roles edit with.
          - `member` is the one editable built-in cell: its boxes ARE the tenant defaults
            (tenant#space_creator wildcard / api_key_issue, #496) through the unchanged endpoint, and
            stay disabled until the defaults have ARRIVED (an authz control must not guess its state).
          - Custom rows: live per-op capability toggles (#445), pencil rename, #504 red delete. */}
      <div className="mb-2 flex flex-col gap-4" data-testid="roles-list">
        {/* #581: the two groups are SURFACES, not a pair of small grey labels above a continuous run of
            rows. A card each — border, panel background, its own heading bar — so the boundary is
            visible before you read anything, which is what lets the per-row scope badge go away. */}
        <section className="rounded-md border border-border bg-panel">
          <h3 className="m-0 border-b border-border px-3 py-2 text-xs font-medium uppercase tracking-wide text-fg-dim" data-testid="roles-section-tenant">{t("adminRoles.sectionTenant")}</h3>
          {/* #539 / #521 / #503: the same 26rem box + inner scroll, because this list grows with the
              tenant's roles and this is the fourth list to hit that. The page keeps its own scroll. */}
          <div className="flex max-h-[26rem] flex-col gap-2 overflow-y-auto p-3" data-testid="roles-list-tenant">
          <div className="flex flex-col gap-1" data-testid="builtin-role-member">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">member</span>
              <RoleBadges builtIn />
            </div>
            <CapabilityPicker
              value={[
                ...((defaults.data?.member.createSpaces ?? true) ? ["createSpaces"] : []),
                // #496: default OFF — provisioning seeds no member tuple, so issuance starts admin-only.
                ...((defaults.data?.member.issueApiKeys ?? false) ? ["issueApiKeys"] : []),
              ]}
              idPrefix="builtin-member"
              list={TENANT_CAPABILITIES}
              disabled={!defaults.data || setDefaults.isPending}
              onChange={(caps) => setDefaults.mutate({ memberCreateSpaces: caps.includes("createSpaces"), memberIssueApiKeys: caps.includes("issueApiKeys") }, {
                onSuccess: () => notify.success(t("toast.saved")),
                onError,
              })}
            />
          </div>
          <div className="flex flex-col gap-1" data-testid="builtin-role-admin">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">admin</span>
              <RoleBadges builtIn />
            </div>
            <CapabilityPicker value={["createSpaces", "issueApiKeys"]} idPrefix="builtin-admin" list={TENANT_CAPABILITIES} disabled />
          </div>
          {(roles.data?.custom ?? []).filter((r) => r.scope === "tenant").map(renderCustomRole)}
          </div>
        </section>
        <section className="rounded-md border border-border bg-panel">
          <h3 className="m-0 border-b border-border px-3 py-2 text-xs font-medium uppercase tracking-wide text-fg-dim" data-testid="roles-section-resource">{t("adminRoles.sectionResource")}</h3>
          <div className="flex max-h-[26rem] flex-col gap-2 overflow-y-auto p-3" data-testid="roles-list-resource">
          {(roles.data?.builtIn ?? []).map((r) => (
            <div key={r.name} className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">{r.name}</span>
                <RoleBadges builtIn />
              </div>
              <CapabilityPicker value={r.capabilities} idPrefix={`builtin-${r.name}`} list={CAPABILITIES} disabled />
            </div>
          ))}
          {(roles.data?.custom ?? []).filter((r) => r.scope !== "tenant").map(renderCustomRole)}
          </div>
        </section>
        {(roles.data?.custom.length ?? 0) === 0 && <p className="m-0 text-xs text-fg-dim">{t("adminRoles.customEmpty")}</p>}
      </div>
      {creating ? (
        <RoleEditor pending={createRole.isPending}
          onCancel={() => setCreating(false)}
          onSave={(v) => createRole.mutate(v, {
            onSuccess: () => { notify.success(t("toast.saved")); setCreating(false); },
            onError,
          })} />
      ) : (
        <Button variant="default" size="sm" data-testid="role-create" onClick={() => setCreating(true)}>{t("adminRoles.create")}</Button>
      )}

      {/* #514 / ADR-188 slice 4: this tab DEFINES roles; it no longer grants them. A resource role is
          assigned where the resource is (a space's Members tab, #485) and a tenant role where the
          principal is (the Members page) — assignment living next to the definitions is what made
          "define" and "grant" read as one screen. Authorization is untouched by the move: every
          assign/unassign still goes through requireAssignmentAuthority on the server. */}
      {/* #497 / ADR-183 §3: the tenant default role — a tenant-scope custom role conferred on any
          member no mapping matches (applied at their next login; manual assignments win). */}
      <h3 className="mt-8 text-sm font-medium">{t("adminRoles.defaultRoleTitle")}</h3>
      <p className="mt-0 mb-2 text-xs text-fg-dim">{t("adminRoles.defaultRoleBody")}</p>
      <Select
        size="sm"
        value={defaultRole.data?.defaultRoleId ?? ""}
        ariaLabel={t("adminRoles.defaultRoleTitle")}
        testId="default-role"
        options={[
          { value: "", label: t("adminRoles.defaultRoleNone") },
          ...tenantRoles.map((r) => ({ value: r.id, label: r.name })),
        ]}
        onChange={(v) => setDefaultRole.mutate(v || null, {
          onSuccess: () => notify.success(t("toast.saved")),
          onError,
        })}
      />
      {tenantRoles.length === 0 && <p className="mt-1.5 text-xs text-fg-dim">{t("adminRoles.defaultRoleNeedsTenant")}</p>}

      {/* #497 / ADR-183: declarative group → role mappings. A mapping confers a custom role on an IdP
          group; membership resolves live (no reconcile). Same server machinery as assignment (,
          #485 per-scope authority) — the console lists every mapping and flags an orphaned one whose
          group no member currently carries (IdP rename/empty; surfaced, never auto-migrated). */}
      {/* #514 / ADR-188 §8: TENANT-scope mappings only. A mapping onto a SPACE role is that space's own
          configuration and is made in its Members tab — the same symmetry as assignment (slice 4), so a
          space manager can set it up without a screen only tenant admins can open. */}
      <h3 className="mt-8 text-sm font-medium">{t("adminRoles.mappingTitle")}</h3>
      <p className="mt-0 mb-2 text-xs text-fg-dim">{t("adminRoles.mappingTenantBody")}</p>
      <div className="mb-3 flex flex-wrap items-end gap-3" data-testid="mapping-form">
        <label className="flex w-56 flex-col gap-1 text-xs text-fg-dim">
          {t("adminRoles.mappingGroupLabel")}
          <Input inputSize="sm" value={mapGroup} placeholder={t("adminRoles.mappingGroupPlaceholder")}
            aria-label={t("adminRoles.mappingGroupLabel")} data-testid="mapping-group" onChange={(e) => setMapGroup(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-xs text-fg-dim">
          {t("adminRoles.roleLabel")}
          <Select size="sm" value={mapRoleId} ariaLabel={t("adminRoles.roleLabel")} testId="mapping-role"
            options={(roles.data?.custom ?? []).filter((r) => r.scope === "tenant").map((r) => ({ value: r.id, label: r.name }))}
            onChange={setMapRoleId} />
        </label>
        <span className="pb-1.5 text-xs text-fg-dim" data-testid="mapping-tenant-note">{t("adminRoles.assignTenantScope")}</span>
        <Button variant="primary" size="sm" data-testid="mapping-add"
          disabled={!mapGroup.trim() || !mapRoleId || !mapResourceId || createMapping.isPending}
          onClick={() => createMapping.mutate({ groupName: mapGroup.trim(), roleId: mapRoleId, resourceType: mapScope, resourceId: mapResourceId }, {
            onSuccess: () => { notify.success(t("toast.saved")); setMapGroup(""); },
            onError,
          })}>{t("adminRoles.mappingAdd")}</Button>
      </div>
      <div className="flex flex-col gap-1" data-testid="mapping-list">
        {mappings.data?.map((m) => (
          <div key={m.id} className="flex items-center gap-2 text-sm" data-testid="mapping-row">
            <span className="min-w-0 truncate font-medium">{m.groupName}</span>
            <ArrowRight size={12} className="shrink-0 text-fg-dim" aria-hidden />
            {/* #497: a space-scope mapping said only which ROLE it confers, so two mappings of the same
                role to different spaces read identically — the row could not tell you what it did. The
                space name comes from the list this tab already holds; nothing new is asked of the server,
                so no projection and no authority changes. A space that is not in that list (a space
                manager looking at a filtered view) shows no scope rather than a raw id. */}
            <span className="min-w-0 flex-1 truncate text-xs text-fg-dim">{m.roleName}{mappingScope(m)}</span>
            {m.orphaned && (
              <span className="rounded border border-[var(--callout-warning)] px-1 text-[10px] uppercase tracking-wide text-[var(--callout-warning)]" data-testid="mapping-orphan" data-tip={t("adminRoles.mappingOrphanHint")}>{t("adminRoles.mappingOrphan")}</span>
            )}
            {/* #504: deleting a mapping revokes its group assignment — red trigger + confirm. */}
            <IconButton aria-label={t("adminRoles.mappingRemove")} data-testid="mapping-remove" variant="danger"
              onClick={() => setDeletingMapping({ id: m.id, groupName: m.groupName, roleName: m.roleName })}><X size={14} /></IconButton>
          </div>
        ))}
        {(mappings.data?.length ?? 0) === 0 && <p className="m-0 text-xs text-fg-dim">{t("adminRoles.mappingEmpty")}</p>}
      </div>

      {/* #504: the role-delete confirm — names the role, danger tone. */}
      <ConfirmDialog
        open={deletingRole !== null}
        message={deletingRole ? t("adminRoles.deleteConfirm", { name: deletingRole.name }) : ""}
        confirmTestId="role-delete-confirm"
        onClose={() => setDeletingRole(null)}
        onConfirm={() => {
          if (!deletingRole) return;
          deleteRole.mutate(deletingRole.id, { onSuccess: () => notify.success(t("toast.saved")), onError });
          setDeletingRole(null);
        }}
      />
      {/* #497: deleting a mapping revokes the group's conferred role — name it, danger tone. */}
      <ConfirmDialog
        open={deletingMapping !== null}
        message={deletingMapping ? t("adminRoles.mappingDeleteConfirm", { group: deletingMapping.groupName, role: deletingMapping.roleName }) : ""}
        confirmTestId="mapping-delete-confirm"
        onClose={() => setDeletingMapping(null)}
        onConfirm={() => {
          if (!deletingMapping) return;
          deleteMapping.mutate(deletingMapping.id, { onSuccess: () => notify.success(t("toast.saved")), onError });
          setDeletingMapping(null);
        }}
      />
    </div>
  );
}
