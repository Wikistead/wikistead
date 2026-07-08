import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { FileStack } from "lucide-react";
import { renderMarkdownToHtml } from "@wikistead/macro-render";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { Button } from "../ui/Button";
import { useTemplates, useTemplateBody, type TemplateSummary } from "../data/queries";

// #250 / ADR-110: the "create from template" picker (opened from the sidebar split- ▾). Lists the
// templates the user can view (server FGA-filtered), grouped by scope — Personal / This space / Tenant
// with a live sanitized preview (renderMarkdownToHtml with the empty macro registry: client-side draw only,
// embed/transclude never server-resolved). Choosing one calls onPick(templateId); the caller creates the
// page (server re-checks template view + destination edit — two-layer defence).
export function TemplatePickerDialog({
  open,
  spaceId,
  onClose,
  onPick,
}: {
  open: boolean;
  spaceId: string | null;
  onClose: () => void;
  onPick: (templateId: string) => void;
}) {
  const { t } = useTranslation();
  const { data, isLoading } = useTemplates(open);
  const [selected, setSelected] = useState<string | null>(null);
  const body = useTemplateBody(open ? selected : null);

  // Group into the three ADR-110 buckets. Space-scope templates are shown only for the CURRENT space
  // (the picker is contextual to where the page will be created); personal/tenant are always relevant.
  const groups = useMemo(() => {
    const all = data ?? [];
    return [
      { key: "personal", items: all.filter((x) => x.scope === "personal") },
      { key: "space", items: all.filter((x) => x.scope === "space" && x.spaceId === spaceId) },
      { key: "tenant", items: all.filter((x) => x.scope === "tenant") },
    ].filter((g) => g.items.length > 0);
  }, [data, spaceId]);

  const empty = !isLoading && groups.length === 0;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent data-testid="template-picker" className="sm:max-w-[720px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><FileStack size={16} /> {t("templatePicker.title")}</DialogTitle>
        </DialogHeader>
        {isLoading ? (
          <p className="py-8 text-center text-fg-dim">{t("common.loading")}</p>
        ) : empty ? (
          <p className="py-8 text-center text-fg-dim" data-testid="template-picker-empty">{t("templatePicker.empty")}</p>
        ) : (
          <div className="flex min-h-[18rem] gap-3">
            {/* Left: the grouped list. */}
            <ul className="w-1/2 min-w-0 overflow-auto border-r border-border pr-2">
              {groups.map((g) => (
                <li key={g.key} className="mb-2">
                  <div className="px-1 py-1 text-[length:var(--text-xs)] font-medium uppercase tracking-wide text-fg-dim">
                    {t(`template.scope.${g.key}`)}
                  </div>
                  {g.items.map((tpl: TemplateSummary) => (
                    <button
                      key={tpl.id}
                      type="button"
                      data-testid="template-picker-item"
                      data-selected={selected === tpl.id ? "true" : undefined}
                      onClick={() => setSelected(tpl.id)}
                      onDoubleClick={() => onPick(tpl.id)}
                      className={`flex w-full flex-col items-start gap-0.5 rounded px-2 py-1.5 text-left hover:bg-panel-2 ${selected === tpl.id ? "bg-panel-2" : ""}`}
                    >
                      <span className="min-w-0 truncate font-medium">{tpl.name}</span>
                    </button>
                  ))}
                </li>
              ))}
            </ul>
            {/* Right: sanitized preview of the frozen body. */}
            <div className="flex w-1/2 min-w-0 flex-col">
              <div className="min-h-0 flex-1 overflow-auto rounded border border-border p-3" data-testid="template-picker-preview">
                {!selected ? (
                  <p className="text-fg-dim">{t("templatePicker.selectPrompt")}</p>
                ) : body.isLoading || !body.data ? (
                  <p className="text-fg-dim">{t("common.loading")}</p>
                ) : (
                  <div
                    className="text-[length:var(--text-body)] leading-relaxed [&_h1]:mb-2 [&_h1]:text-[length:var(--text-lg)] [&_h1]:font-semibold [&_h2]:mb-1 [&_h2]:mt-3 [&_h2]:font-semibold [&_p]:my-2 [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_code]:rounded [&_code]:bg-panel-2 [&_code]:px-1"
                    data-testid="template-picker-preview-body"
                    dangerouslySetInnerHTML={{ __html: renderMarkdownToHtml(body.data.body).toString() }}
                  />
                )}
              </div>
              <div className="mt-3 flex justify-end">
                <Button variant="primary" type="button" disabled={!selected} data-testid="template-picker-use" onClick={() => selected && onPick(selected)}>
                  {t("templatePicker.use")}
                </Button>
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
