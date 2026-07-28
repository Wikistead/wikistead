import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useSession } from "../session/SessionProvider";
import { Button, IconButton } from "../ui/Button";
import { Select } from "../ui/Select";
import { notify } from "../ui/toast";
import { useRoles, useRoleAssignments, useAssignRole, useUnassignRole } from "../data/queries";
import type { Member } from "../data/membersApi";
import { X } from "lucide-react"; // #544: icon component, not a text glyph

// #514 / ADR-188 slice 4: TENANT-scope role assignment lives with the MEMBERS, not on the Roles tab.
//
// The IA rule the ADR settles: a RESOURCE role is assigned where the resource is (a space's Members tab,
// #485) and a TENANT role is assigned where the principal is (this page) — a tenant role like
// `createSpaces` is an attribute of a member, not of any resource, so the Roles tab keeps only the
// DEFINITIONS. Assignment used to live there too, which is what made "define" and "grant" look like the
// same screen.
//
// Authorization is unchanged by the move: every assign/unassign goes through the same
// `requireAssignmentAuthority` gate on the server (tenant scope → tenant admin) no matter which screen
// called it. This component is chrome — the server is the authority.
export function TenantRoleAssignments({ members }: { members: readonly Member[] }) {
  const { t } = useTranslation();
  const { tenantId } = useSession();
  const roles = useRoles();
  const assignments = useRoleAssignments("tenant", tenantId);
  const assign = useAssignRole();
  const unassign = useUnassignRole();
  const [roleId, setRoleId] = useState("");
  const [sub, setSub] = useState("");

  const tenantRoles = (roles.data?.custom ?? []).filter((r) => r.scope === "tenant");
  // Nothing to assign and nothing assigned → the section would be an empty box on every tenant that
  // never defined a tenant role. Stay out of the way instead.
  if (tenantRoles.length === 0 && (assignments.data?.length ?? 0) === 0) return null;

  // #514 slice 6: one row PER MEMBER carrying all their roles, not one row per assignment — a member
  // with three roles used to appear three times. Removal stays per-assignment (the server's unassign is
  // reference-counted,), so each role keeps its own ×.
  const byPrincipal = new Map<string, { id: string; roleName: string }[]>();
  for (const a of assignments.data ?? []) {
    const list = byPrincipal.get(a.principal) ?? [];
    list.push({ id: a.id, roleName: a.roleName });
    byPrincipal.set(a.principal, list);
  }
  // #513: show the person, not the hash. The member list is already loaded here, so the sub only
  // surfaces when it belongs to nobody on it (a group principal, or a member since removed).
  const nameOf = (principal: string): string => {
    const s = principal.replace(/^user:/, "");
    const m = members.find((x) => x.sub === s);
    return m ? (m.display_name || m.email || s) : principal;
  };
  const onError = () => notify.error(t("toast.actionFailed"));

  return (
    <section className="mb-8" data-testid="tenant-role-assignments">
      <h3 className="mt-0 text-sm font-medium">{t("adminRoles.tenantAssignTitle")}</h3>
      <p className="mt-0 mb-2 text-xs text-fg-dim">{t("adminRoles.tenantAssignBody")}</p>

      <div className="mb-3 flex flex-wrap items-end gap-3" data-testid="tenant-assign-form">
        <Select size="sm" value={roleId} ariaLabel={t("adminRoles.roleLabel")} testId="tenant-assign-role"
          options={[{ value: "", label: t("adminRoles.rolePlaceholder") }, ...tenantRoles.map((r) => ({ value: r.id, label: r.name }))]}
          onChange={setRoleId} />
        <Select size="sm" value={sub} ariaLabel={t("adminRoles.memberLabel")} testId="tenant-assign-member"
          options={[{ value: "", label: t("adminRoles.memberPlaceholder") },
            ...members.map((m) => ({ value: m.sub, label: m.display_name || m.email || m.sub }))]}
          onChange={setSub} />
        <Button variant="primary" size="sm" data-testid="tenant-assign-add"
          disabled={!roleId || !sub || assign.isPending}
          onClick={() => assign.mutate(
            { roleId, resourceType: "tenant", resourceId: tenantId, principal: `user:${sub}` },
            { onSuccess: () => { notify.success(t("toast.saved")); setSub(""); }, onError },
          )}>{t("adminRoles.assign")}</Button>
      </div>

      <div className="flex flex-col gap-1" data-testid="tenant-assignment-list">
        {[...byPrincipal.entries()].map(([principal, held]) => (
          <div key={principal} className="flex items-center gap-2 text-sm" data-testid="tenant-assignment-row">
            <span className="min-w-0 flex-1 truncate">{nameOf(principal)}</span>
            {held.map((h) => (
              <span key={h.id} className="inline-flex items-center gap-1 text-xs text-fg-dim">
                {h.roleName}
                <IconButton aria-label={t("adminRoles.unassign")} data-testid="tenant-assignment-remove" variant="danger"
                  onClick={() => unassign.mutate(h.id, { onSuccess: () => notify.success(t("toast.saved")), onError })}><X size={14} /></IconButton>
              </span>
            ))}
          </div>
        ))}
        {byPrincipal.size === 0 && <p className="m-0 text-xs text-fg-dim">{t("adminRoles.assignEmpty")}</p>}
      </div>
    </section>
  );
}
