import { useNavigate } from "react-router-dom";
import { ListBox } from "../ui/list-rows";
import { useTranslation } from "react-i18next";
import { useAdminSpaces, useAdminDeleteMode, useSetAdminDeleteMode } from "../data/queries";
import { Button } from "../ui/Button";
import { Select } from "../ui/Select";
import { notify } from "../ui/toast";
import { SettingsPane } from "./SettingsShell"; // #735: the pane draws the frame AND the heading

// Tenant admin → Spaces overview (Phase 5 #4). Lists every space in the tenant
// with page + direct-grant counts, and links to each space's settings. tenant#admin
// gated server-side (the AdminLayout already gates the whole console on isAdmin).
export function AdminSpacesTab() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const spaces = useAdminSpaces();
  // #437 / ADR-167: tenant default delete-mode (pathways only; WHO may delete never changes).
  const deleteMode = useAdminDeleteMode();
  const setDeleteMode = useSetAdminDeleteMode();

  return (
    <SettingsPane width="list" testId="admin-spaces" title={t("adminSpaces.title")}>

      {/* #445 / ADR-171: who may create spaces moved to Admin → Roles (the member default-role
          createSpaces preset) — the #399 §2 policy select is retired. */}
      <p className="mt-0 mb-4 text-sm text-fg-dim">{t("adminSpaces.creationMovedToRoles")}</p>
      <div className="mb-6" data-testid="admin-delete-mode">
        <h3 className="mt-0 text-sm font-medium">{t("adminSpaces.deleteModeTitle")}</h3>
        <p className="mt-0 mb-2 text-sm text-fg-dim">{t("adminSpaces.deleteModeBody")}</p>
        <Select
          size="sm"
          value={deleteMode.data?.deleteMode ?? "trash_only"}
          disabled={deleteMode.isLoading || setDeleteMode.isPending}
          ariaLabel={t("adminSpaces.deleteModeTitle")}
          testId="admin-delete-mode-select"
          options={[
            { value: "trash_only", label: t("deleteMode.trash_only") },
            { value: "both", label: t("deleteMode.both") },
            { value: "direct_only", label: t("deleteMode.direct_only") },
          ]}
          onChange={(v) => setDeleteMode.mutate(v, {
            onSuccess: () => notify.success(t("toast.saved")),
            onError: () => notify.error(t("toast.actionFailed")),
          })}
        />
      </div>
      {spaces.isLoading && <p className="text-sm text-fg-dim">{t("common.loading")}</p>}
      {!spaces.isLoading && (spaces.data?.length ?? 0) === 0 && <p className="text-sm text-fg-dim">{t("adminSpaces.empty")}</p>}

      {(spaces.data?.length ?? 0) > 0 && (
        <ListBox>
          {/* #623 slice 10: the shared box from #639 — the same 26rem everywhere, so a long list
              scrolls inside itself instead of growing the page. The server bound landed in slice 4; the
              container waited until #639 settled, so this did not become a second one. */}
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
        </ListBox>
      )}
    </SettingsPane>
  );
}
