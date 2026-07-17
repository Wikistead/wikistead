import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useAdminSpaces } from "../data/queries";
import { Button } from "../ui/Button";

// Tenant admin → Spaces overview (Phase 5 #4). Lists every space in the tenant
// with page + direct-grant counts, and links to each space's settings. tenant#admin
// gated server-side (the AdminLayout already gates the whole console on isAdmin).
export function AdminSpacesTab() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const spaces = useAdminSpaces();

  return (
    <div className="max-w-[720px] p-6" data-testid="admin-spaces">
      <h2 className="mt-0">{t("adminSpaces.title")}</h2>

      {/* #445 / ADR-171: who may create spaces moved to Admin → Roles (the member default-role
          createSpaces preset) — the #399 §2 policy select is retired. */}
      <p className="mt-0 mb-4 text-sm text-fg-dim">{t("adminSpaces.creationMovedToRoles")}</p>
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
