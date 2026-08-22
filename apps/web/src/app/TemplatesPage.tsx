import { useState } from "react";
import { ListBox } from "../ui/list-rows";
import { useTranslation } from "react-i18next";
import { LoadFailed } from "../ui/LoadFailed";
import { Link } from "react-router-dom";
import { ArrowLeft, Eye, FileStack, Pencil, Trash2, X } from "lucide-react";
import { TemplateBodyPreview } from "../editor/TemplateBodyPreview";
import { useTemplates, useTemplateBody, useRenameTemplate, useDeleteTemplate, type TemplateSummary } from "../data/queries";
import { RenameDialog, ConfirmDialog } from "../ui/dialogs";
import { notify } from "../ui/toast";

// #249 / ADR-110: the /templates management page. Lists the templates the user can view (server
// FGA-filtered — scope containment enforced server-side), with a scope badge, rename, and delete. Actions
// are hidden on templates the user can't manage (canManage from the server); the server re-checks anyway
// (two-layer defence). A read-only preview renders the frozen body via the shared sanitized renderer
// (client-side only — embed/transclude are not server-resolved).
export function TemplatesRoute() {
  const { t } = useTranslation();
  const { data, isLoading, isError, refetch } = useTemplates();
  const rename = useRenameTemplate();
  const del = useDeleteTemplate();
  const [renaming, setRenaming] = useState<TemplateSummary | null>(null);
  const [deleting, setDeleting] = useState<TemplateSummary | null>(null);
  const [previewing, setPreviewing] = useState<TemplateSummary | null>(null);
  const templates = data ?? [];

  return (
    <div className="mx-auto max-w-[46rem] px-4 py-8 text-[length:var(--text-ui)]" data-testid="templates-page">
      <Link to="/" className="mb-4 inline-flex items-center gap-1 text-fg-dim hover:text-foreground" data-testid="templates-back">
        <ArrowLeft size={14} /> {t("templates.back")}
      </Link>
      <h1 className="mb-4 flex items-center gap-2 text-[length:var(--text-lg)] font-semibold">
        <FileStack size={18} /> {t("templates.title")}
      </h1>
      {isLoading ? (
        <p className="text-fg-dim">{t("common.loading")}</p>
      ) : isError ? (
        // #895: "you have no templates" is a claim about the reader's own library.
        <LoadFailed testId="templates-failed" onRetry={() => { void refetch(); }} />
      ) : templates.length === 0 ? (
        <p className="text-fg-dim" data-testid="templates-empty">{t("templates.empty")}</p>
      ) : (
        <ListBox>
          {/* #623 slice 10: the shared box from #639 — the same 26rem everywhere, so a long list
              scrolls inside itself instead of growing the page. The server bound landed in slice 4; the
              container waited until #639 settled, so this did not become a second one. */}
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
                <button type="button" className="flex-none rounded p-1 text-fg-dim hover:bg-panel-2 hover:text-foreground" data-tip={t("templates.preview")} data-testid="template-preview" onClick={() => setPreviewing(tpl)}>
                  <Eye size={14} />
                </button>
                {tpl.canManage && (
                  <>
                    <button type="button" className="flex-none rounded p-1 text-fg-dim hover:bg-panel-2 hover:text-foreground" data-tip={t("templates.rename")} data-testid="template-rename" onClick={() => setRenaming(tpl)}>
                      <Pencil size={14} />
                    </button>
                    {/* #504: red at rest (was hover-only) — the confirm below already exists. */}
                    <button type="button" className="flex-none rounded p-1 text-destructive hover:bg-[color-mix(in_srgb,var(--danger)_12%,transparent)]" data-tip={t("common.delete")} data-testid="template-delete" onClick={() => setDeleting(tpl)}>
                      <Trash2 size={14} />
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
      </ListBox>
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
      {previewing && <TemplatePreview tpl={previewing} onClose={() => setPreviewing(null)} />}
    </div>
  );
}

// A read-only preview of the template's frozen body. #267 mounts the editor's own read-only
// surface (TemplateBodyPreview → mountPublishedView) so the preview renders structurally identical to
// the real page — same engine, same trust boundary members already render each other's content with.
function TemplatePreview({ tpl, onClose }: { tpl: TemplateSummary; onClose: () => void }) {
  const { t } = useTranslation();
  const { data, isLoading } = useTemplateBody(tpl.id);
  return (
    <div className="mt-4 rounded-md border border-border" data-testid="template-preview-panel">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Eye size={14} className="text-fg-dim" />
        <span className="min-w-0 flex-1 truncate font-medium">{tpl.name}</span>
        <button type="button" className="flex-none rounded p-1 text-fg-dim hover:bg-panel-2 hover:text-foreground" data-tip={t("common.close")} data-testid="template-preview-close" onClick={onClose}>
          <X size={14} />
        </button>
      </div>
      <div className="flex h-[24rem] flex-col overflow-hidden">
        {isLoading || !data ? (
          <p className="p-3 text-fg-dim">{t("common.loading")}</p>
        ) : (
          <TemplateBodyPreview body={data.body} templateId={tpl.id} testid="template-preview-body" />
        )}
      </div>
    </div>
  );
}
