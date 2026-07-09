import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { FileStack } from "lucide-react";
import { renderMarkdownToDom } from "../editor/macros/md-render";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { Button } from "../ui/Button";
import { useTemplates, useTemplateBody, type TemplateSummary } from "../data/queries";

// #250 / ADR-110: the "create from template" picker (opened from the sidebar split- ▾). Lists the
// templates the user can view (server FGA-filtered), grouped by scope — Personal / This space / Tenant
// with a live preview. #267: the preview renders via renderMarkdownToDom — the SAME client DOM renderer the
// public reader (#227) uses — so ALL first-party macros render (callout/columns/tabs recurse their body,
// `:::table` builds a real table from its escaped-cell model, mermaid/plantuml draw). It builds the DOM
// node-by-node from an allowlist (textContent, never innerHTML), so it is the XSS boundary itself — no
// dangerouslySetInnerHTML, no sanitizer-sharing (that's why the old previewMacroRegistry table-exclusion is
// gone). Still client-only: the embed macros are static placeholders that never fetch (ADR-110's concern was
// server-resolving embeds). Choosing one calls onPick(templateId); the caller creates the page (server
// re-checks template view + destination edit — two-layer defence).
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
  // #267: render the frozen body with the public-reader DOM renderer via a ref + replaceChildren (no
  // dangerouslySetInnerHTML — renderMarkdownToDom IS the sanitizer, building text nodes from an allowlist).
  const [previewEl, setPreviewEl] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!previewEl) return;
    previewEl.replaceChildren(body.data?.body != null ? renderMarkdownToDom(body.data.body) : document.createDocumentFragment());
  }, [previewEl, body.data]);

  // Group into the three ADR-110 buckets. Space-scope templates are shown only for the CURRENT space
  // (the picker is contextual to where the page will be created); personal/tenant are always relevant.
  const groups = useMemo(() => {
    const all = data ?? [];
    return [
      { key: "personal", items: all.filter((x) => x.scope === "personal") },
      // When a space is given (sidebar #250) show only that space's templates; when null (the #251 insert
      // picker, which isn't threaded the page's space) show every space-scope template the user can view.
      { key: "space", items: all.filter((x) => x.scope === "space" && (spaceId == null || x.spaceId === spaceId)) },
      { key: "tenant", items: all.filter((x) => x.scope === "tenant") },
    ].filter((g) => g.items.length > 0);
  }, [data, spaceId]);

  const empty = !isLoading && groups.length === 0;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent data-testid="template-picker" className="sm:max-w-[720px] max-h-[85vh] overflow-hidden">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><FileStack size={16} /> {t("templatePicker.title")}</DialogTitle>
        </DialogHeader>
        {isLoading ? (
          <p className="py-8 text-center text-fg-dim">{t("common.loading")}</p>
        ) : empty ? (
          <p className="py-8 text-center text-fg-dim" data-testid="template-picker-empty">{t("templatePicker.empty")}</p>
        ) : (
          // #267 this row is a GRID ITEM of DialogContent (shadcn grid). A grid item's default
          // min-width is AUTO = its content's min-content — so heavy preview content (wide mermaid/table,
          // min-content ~1100px+) floored the row wider than the 720px dialog and pushed the right pane
          // out of frame (measured: row 1351px vs dialog 720px, min-width:auto). min-w-0 removes that
          // floor; w-full/max-w-full pin the row to the dialog's inner width structurally.
          <div className="flex min-h-0 max-h-[60vh] h-[60vh] w-full max-w-full min-w-0 gap-3">
            {/* Left: the grouped list. */}
            <ul className="w-1/2 min-w-0 min-h-0 overflow-auto border-r border-border pr-2">
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
                    ref={setPreviewEl}
                    className="cm-lp-md-preview text-[length:var(--text-body)] leading-relaxed"
                    data-testid="template-picker-preview-body"
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
