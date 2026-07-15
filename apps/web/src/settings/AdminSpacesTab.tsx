import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useAdminSpaces, useSpaceCreationPolicy, useSetSpaceCreationPolicy } from "../data/queries";
import { Button } from "../ui/Button";
import { Select } from "../ui/Select";
import { notify } from "../ui/toast";

// Tenant admin → Spaces overview (Phase 5 #4). Lists every space in the tenant
// with page + direct-grant counts, and links to each space's settings. tenant#admin
// gated server-side (the AdminLayout already gates the whole console on isAdmin).
export function AdminSpacesTab() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const spaces = useAdminSpaces();
  // #399 / ADR-158 §2: tenant-wide space-creation policy (restrict-only knob; the server is the
  // fortress — createSpace re-checks; the personal auto-create is exempt by design).
  const creationPolicy = useSpaceCreationPolicy();
  const setCreationPolicy = useSetSpaceCreationPolicy();

  return (
    <div className="max-w-[720px] p-6" data-testid="admin-spaces">
      <h2 className="mt-0">{t("adminSpaces.title")}</h2>

      <div className="mb-6" data-testid="space-creation-policy">
        <h3 className="mt-0 text-sm font-medium">{t("adminSpaces.creationPolicyTitle")}</h3>
        <p className="mt-0 mb-2 text-sm text-fg-dim">{t("adminSpaces.creationPolicyBody")}</p>
        <Select
          size="sm"
          value={creationPolicy.data?.spaceCreationPolicy ?? "members"}
          disabled={creationPolicy.isLoading || setCreationPolicy.isPending}
          ariaLabel={t("adminSpaces.creationPolicyTitle")}
          testId="space-creation-policy-select"
          options={[
            { value: "members", label: t("adminSpaces.creationPolicyMembers") },
            { value: "admins", label: t("adminSpaces.creationPolicyAdmins") },
          ]}
          onChange={(v) => setCreationPolicy.mutate(v, {
            onSuccess: () => notify.success(t("toast.saved")),
            onError: () => notify.error(t("toast.actionFailed")),
          })}
        />
      </div>
      {spaces.isLoading && <p className="text-sm text-fg-dim">{t("common.loading")}</p>}
      {!spaces.isLoading && (spaces.data?.length ?? 0) === 0 && <p className="text-sm text-fg-dim">{t("adminSpaces.empty")}</p>}

      {(spaces.data?.length ?? 0) > 0 && (
        <table className="w-full border-collapse text-sm [&_td]:border-b [&_td]:border-border [&_td]:p-2 [&_th]:border-b [&_th]:border-border [&_th]:px-2 [&_th]:py-1.5 [&_th]:text-[11px] [&_th]:font-semibold [&_th]:uppercase [&_th]:tracking-[0.03em] [&_th]:text-fg-dim">
          <thead>
            <tr>
              <th className="text-left">{t("adminSpaces.name")}</th>
              <th className="w-[72px] text-right">{t("adminSpaces.pages")}</th>
              <th className="w-[72px] text-right">{t("adminSpaces.sharedWith")}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {spaces.data!.map((s) => (
              <tr key={s.id} data-testid="admin-space-row">
                <td>{s.name || t("sidebar.untitledSpace")}</td>
                <td className="w-[72px] text-right">{s.pageCount}</td>
                <td className="w-[72px] text-right">{s.grantCount}</td>
                <td className="w-[96px] text-right">
                  <Button size="sm" variant="ghost" data-testid="admin-space-settings" onClick={() => navigate(`/spaces/${s.id}/settings`)}>{t("adminSpaces.manage")}</Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
