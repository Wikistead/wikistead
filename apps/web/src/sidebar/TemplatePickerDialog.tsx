import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { LoadFailed } from "../ui/LoadFailed";
import { FileStack } from "lucide-react";
import { TemplateBodyPreview } from "../editor/TemplateBodyPreview";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { Button } from "../ui/Button";
import { useTemplates, useTemplateBody, type TemplateSummary } from "../data/queries";

// #250 / ADR-110: the "create from template" picker (opened from the sidebar split- ▾). Lists the
// templates the user can view (server FGA-filtered), grouped by scope — Personal / This space / Tenant
// with a live preview. #267 the preview mounts the EDITOR'S OWN read-only surface
// (TemplateBodyPreview → mountPublishedView), so it renders structurally identical to the real page
// math, checkboxes, highlighting, wrapping, every macro. Choosing one calls onPick(templateId); the
// caller creates the page (server re-checks template view + destination edit — two-layer defence).
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
  const { data, isLoading, isError, refetch } = useTemplates(open);
  const [selected, setSelected] = useState<string | null>(null);
  const body = useTemplateBody(open ? selected : null);
  const selectedRef = useRef<HTMLButtonElement | null>(null);
  // Keep the highlighted row visible as Ctrl-j/k / arrows walk a long, scrolling list (block:"nearest" scrolls
  // the minimum needed). Fires only on selection change, so it costs nothing while the list is static.
  useEffect(() => { selectedRef.current?.scrollIntoView({ block: "nearest" }); }, [selected]);

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

  // #366: unify the picker keyboard model with the embed/page-link picker (PageEmbedPicker) — auto-highlight the
  // first candidate (Enter confirms without arrowing → the right preview follows), and move the highlight with
  // Ctrl-j/k / arrows over the FLATTENED order (the visual top-to-bottom sequence across the scope groups).
  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);
  useEffect(() => {
    if (flat.length === 0) { if (selected !== null) setSelected(null); return; }
    if (!flat.some((i) => i.id === selected)) setSelected(flat[0]!.id);
  }, [flat, selected]);
  const moveSelection = (delta: number) => {
    if (flat.length === 0) return;
    const cur = flat.findIndex((i) => i.id === selected);
    const next = cur < 0 ? 0 : Math.min(flat.length - 1, Math.max(0, cur + delta));
    setSelected(flat[next]!.id);
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "j")) { e.preventDefault(); moveSelection(+1); }
    else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "k")) { e.preventDefault(); moveSelection(-1); }
    else if (e.key === "Enter" && selected) { e.preventDefault(); onPick(selected); }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent data-testid="template-picker" className="sm:max-w-[720px] max-h-[85vh] overflow-hidden" onKeyDown={onKeyDown}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><FileStack size={16} /> {t("templatePicker.title")}</DialogTitle>
        </DialogHeader>
        {isLoading ? (
          <p className="py-8 text-center text-fg-dim">{t("common.loading")}</p>
        ) : empty ? (
          isError
            ? <LoadFailed testId="template-picker-failed" onRetry={() => { void refetch(); }} />
            : <p className="py-8 text-center text-fg-dim" data-testid="template-picker-empty">{t("templatePicker.empty")}</p>
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
                      ref={selected === tpl.id ? selectedRef : undefined}
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
            {/* Right: the frozen body rendered by the editor's own read-only surface (#267). The
                pane clips; the CM view inside owns the scrolling (its .cm-scroller — engine parity). */}
            <div className="flex w-1/2 min-w-0 flex-col">
              <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded border border-border" data-testid="template-picker-preview">
                {!selected ? (
                  <p className="p-3 text-fg-dim">{t("templatePicker.selectPrompt")}</p>
                ) : body.isLoading || !body.data ? (
                  <p className="p-3 text-fg-dim">{t("common.loading")}</p>
                ) : (
                  <TemplateBodyPreview body={body.data.body} templateId={selected} testid="template-picker-preview-body" />
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
