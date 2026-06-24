import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "../components/ui/dialog";
import { usePageRevisions, useRevisionContent, usePublished } from "../data/queries";
import { sideBySide, rowsHaveChanges, type DiffRow } from "./diff";

// Near-fullscreen side-by-side diff (ADR-019 D6 + Design-5 follow-up). Rendered as a
// shadcn Dialog OVERLAY so the editor stays mounted underneath — presence/collab are
// never dropped just to view a diff (the inviolable constraint; an overlay needs no
// special handling, unlike a route change or a surface swap). Read-only: it only reads
// the published snapshot + the revision content (view-system; never joins collab).
function fmt(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function DiffRowCells({ row }: { row: DiffRow }) {
  // left = revision (deletions, red); right = current published (additions, green); a
  // one-line edit (incl. a checkbox flip) is a "change" row with both sides highlighted.
  const leftBg = row.type === "del" || row.type === "change" ? "bg-red-500/15" : row.left ? "" : "bg-muted/40";
  const rightBg = row.type === "add" || row.type === "change" ? "bg-green-500/15" : row.right ? "" : "bg-muted/40";
  const num = "select-none px-2 text-right text-muted-foreground tabular-nums";
  const txt = "whitespace-pre-wrap break-words px-2";
  return (
    <div className="contents" data-testid="diff-row" data-difftype={row.type}>
      <span className={`${num} ${leftBg}`}>{row.left?.lineNo ?? ""}</span>
      <span data-side="left" className={`${txt} ${leftBg}`}>{row.left?.text ?? ""}</span>
      <span className={`${num} ${rightBg} border-l`}>{row.right?.lineNo ?? ""}</span>
      <span data-side="right" className={`${txt} ${rightBg}`}>{row.right?.text ?? ""}</span>
    </div>
  );
}

export function DiffModal({ pageId, revId, onClose }: { pageId: string; revId: string; onClose: () => void }) {
  const { t } = useTranslation();
  const { data: revisions } = usePageRevisions(pageId);
  const { data: oldContent, isLoading } = useRevisionContent(pageId, revId);
  const { data: published } = usePublished(pageId);
  const rev = (revisions ?? []).find((r) => r.id === revId);
  const rows = useMemo(
    () => (oldContent == null ? [] : sideBySide(oldContent, published?.publishedMd ?? "")),
    [oldContent, published?.publishedMd],
  );
  const changed = rowsHaveChanges(rows);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent data-testid="diff-modal" className="flex !max-w-[92vw] h-[88vh] w-[92vw] flex-col gap-3 p-4">
        <DialogHeader className="flex-none">
          <DialogTitle>{rev ? t("history.diffTitle", { when: fmt(rev.createdAt) }) : t("history.title")}</DialogTitle>
          <DialogDescription>{t("history.diffHint")}</DialogDescription>
        </DialogHeader>

        {isLoading && <p className="text-sm text-muted-foreground">{t("common.loading")}</p>}
        {!isLoading && !changed && <p className="text-sm text-muted-foreground" data-testid="diff-no-changes">{t("history.noChanges")}</p>}
        {!isLoading && changed && (
          <div data-testid="diff-grid" className="min-h-0 flex-1 overflow-auto rounded-md border font-mono text-xs leading-relaxed">
            <div className="grid grid-cols-[auto_1fr_auto_1fr]">
              {rows.map((row, i) => (
                <DiffRowCells key={i} row={row} />
              ))}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
