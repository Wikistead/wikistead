import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { ArrowLeft, FileStack, Pencil, Trash2 } from "lucide-react";
import { useTemplates, useRenameTemplate, useDeleteTemplate, type TemplateSummary } from "../data/queries";
import { RenameDialog, ConfirmDialog } from "../ui/dialogs";
import { notify } from "../ui/toast";

// #249 / ADR-110: the /templates management page. Lists the templates the user can view (server
// FGA-filtered — scope containment enforced server-side), with a scope badge, rename, and delete. Actions
// are hidden on templates the user can't manage (canManage from the server); the server re-checks anyway
// (two-layer defence). Preview via the shared sanitized renderer is a follow-up.
export function TemplatesRoute() {
  const { t } = useTranslation();
  const { data, isLoading } = useTemplates();
  const rename = useRenameTemplate();
  const del = useDeleteTemplate();
  const [renaming, setRenaming] = useState<TemplateSummary | null>(null);
  const [deleting, setDeleting] = useState<TemplateSummary | null>(null);
  const templates = data ?? [];

  return (
    <div className="mx-auto max-w-[46rem] px-4 py-8 text-[length:var(--text-ui)]" data-testid="templates-page">
      <Link to="/p/demo" className="mb-4 inline-flex items-center gap-1 text-fg-dim hover:text-foreground" data-testid="templates-back">
        <ArrowLeft size={14} /> {t("templates.back")}
      </Link>
      <h1 className="mb-4 flex items-center gap-2 text-[length:var(--text-lg)] font-semibold">
        <FileStack size={18} /> {t("templates.title")}
      </h1>
      {isLoading ? (
        <p className="text-fg-dim">{t("common.loading")}</p>
      ) : templates.length === 0 ? (
        <p className="text-fg-dim" data-testid="templates-empty">{t("templates.empty")}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
          {templates.map((tpl) => (
            <li key={tpl.id} data-testid="template-row" className="flex items-center gap-2 px-3 py-2">
              <span
                data-testid="template-scope-badge"
                data-scope={tpl.scope}
                className="flex-none rounded border border-border px-1.5 py-0.5 text-[length:var(--text-xs)] text-fg-dim"
              >
                {t(`template.scope.${tpl.scope}`)}
              </span>
              <span className="min-w-0 flex-1 truncate" data-testid="template-name">{tpl.name}</span>
              {tpl.canManage && (
                <>
                  <button type="button" className="flex-none rounded p-1 text-fg-dim hover:bg-panel-2 hover:text-foreground" title={t("templates.rename")} data-testid="template-rename" onClick={() => setRenaming(tpl)}>
                    <Pencil size={14} />
                  </button>
                  <button type="button" className="flex-none rounded p-1 text-fg-dim hover:bg-panel-2 hover:text-[var(--danger)]" title={t("common.delete")} data-testid="template-delete" onClick={() => setDeleting(tpl)}>
                    <Trash2 size={14} />
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      <RenameDialog
        open={renaming !== null}
        initial={renaming?.name ?? ""}
        title={t("templates.rename")}
        label={t("templates.name")}
        onClose={() => setRenaming(null)}
        onSubmit={(name) => {
          if (renaming) rename.mutate({ id: renaming.id, name }, { onSuccess: () => notify.success(t("templates.renamed")), onError: () => notify.error(t("templates.actionFailed")) });
          setRenaming(null);
        }}
      />
      <ConfirmDialog
        open={deleting !== null}
        message={t("templates.deleteConfirm", { name: deleting?.name ?? "" })}
        onClose={() => setDeleting(null)}
        onConfirm={() => {
          if (deleting) del.mutate(deleting.id, { onSuccess: () => notify.success(t("templates.deleted")), onError: () => notify.error(t("templates.actionFailed")) });
          setDeleting(null);
        }}
      />
    </div>
  );
}
