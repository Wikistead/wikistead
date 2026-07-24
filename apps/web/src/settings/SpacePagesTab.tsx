import { useState } from "react";
import { useNavigate, useOutletContext } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Trash2, Upload, Lock, LockOpen, Download } from "lucide-react";
import { useSpacePagesOverview, useBulkDeletePages, useBulkPublishPages, useBulkSetPageVisibility } from "../data/queries";
import { Button } from "../ui/Button";
import { ConfirmDialog } from "../ui/dialogs";
import { notify } from "../ui/toast";
import { downloadSelectionExport } from "../data/exportApi";
import { useSession } from "../session/SessionProvider";

interface SpaceCtx { spaceId: string; name: string; accentKey: string | null }

// #511 / ADR-185: above this selection size the delete confirm escalates from a count-only check to a
// type-to-confirm ("delete"), matching the #504 destructive-op posture for large / high-blast actions.
const TYPE_CONFIRM_THRESHOLD = 20;

// whitespace-nowrap: a squeezed status column must never wrap the badge text vertically (#439).
const chip = "whitespace-nowrap rounded-full border px-2 py-px text-[11px]";

// Space → Pages overview (Phase 5 #5). A manager's-eye view of every page in the
// space: published state, unpublished changes, direct-grant count, active share
// links. space#manage gated server-side (and the whole settings screen is manager-
// only), so it never shows pages outside the manager's authority.
// #511 / ADR-185: the tab also drives BULK operations (delete first) over a multi-select — each page is
// re-authorized server-side (partial success), so the UI is a convenience over a server that is the fort.
export function SpacePagesTab() {
  const { t } = useTranslation();
  const { spaceId } = useOutletContext<SpaceCtx>();
  const navigate = useNavigate();
  const pages = useSpacePagesOverview(spaceId);
  const bulkDelete = useBulkDeletePages();
  const bulkPublish = useBulkPublishPages();
  const bulkVisibility = useBulkSetPageVisibility();
  const { token } = useSession();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [privateConfirmOpen, setPrivateConfirmOpen] = useState(false);

  const rows = pages.data ?? [];
  const allSelected = rows.length > 0 && rows.every((p) => selected.has(p.id));
  const toggle = (id: string) =>
    setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const toggleAll = () =>
    setSelected(allSelected ? new Set() : new Set(rows.map((p) => p.id)));
  const clearSelection = () => setSelected(new Set());

  const runBulkDelete = () => {
    const ids = [...selected];
    setConfirmOpen(false);
    bulkDelete.mutate({ spaceId, pageIds: ids }, {
      onSuccess: (r) => {
        clearSelection();
        // Partial success is the contract: report BOTH outcomes so a caller who could not delete some
        // pages (no permission) is told, never silently left thinking it all worked.
        if (r && r.skipped > 0) notify.info(t("spacePages.bulkDeletePartial", { deleted: r.deleted, skipped: r.skipped }));
        else notify.success(t("spacePages.bulkDeleteDone", { count: r?.deleted ?? 0 }));
      },
      onError: () => notify.error(t("toast.actionFailed")),
    });
  };

  // Publish is NON-destructive (no trash, no cascade), so it runs directly on click — no confirm posture,
  // no type-to-confirm. The server still re-checks the per-page `publish` gate (partial success).
  const runBulkPublish = () => {
    const ids = [...selected];
    bulkPublish.mutate({ spaceId, pageIds: ids }, {
      onSuccess: (r) => {
        clearSelection();
        if (r && r.skipped > 0) notify.info(t("spacePages.bulkPublishPartial", { published: r.published, skipped: r.skipped }));
        else notify.success(t("spacePages.bulkPublishDone", { count: r?.published ?? 0 }));
      },
      onError: () => notify.error(t("toast.actionFailed")),
    });
  };

  // #511 slice 3 (revised per): privatising is NOT reversible by the person doing it. The model
  // subtracts private from the space-inherited chain (`share_from_space: sharer from space but not private`),
  // so the moment a space manager privatises someone else's page they lose `share` on it and cannot clear it
  // again — and tenant admin is inside that same subtraction, so there is no way back except the page's own
  // direct holder. This tab lists the WHOLE space (mostly other people's pages) and the cap is 500, so the
  // make-private direction gets a confirm that says plainly what the caller is giving up. Clearing private
  // hands access back and stays a direct click.
  const runBulkVisibility = (makePrivate: boolean) => {
    const ids = [...selected];
    setPrivateConfirmOpen(false);
    bulkVisibility.mutate({ spaceId, pageIds: ids, makePrivate }, {
      onSuccess: (r) => {
        clearSelection();
        // Three distinct outcomes, never conflated: changed (mutated), unchanged (already in that state —
        // NOT a permission problem, which is what the old "skipped (no permission)" wording claimed), and
        // skipped (the caller's `share` gate said no).
        if (r && r.skipped > 0) notify.info(t("spacePages.bulkVisibilityPartial", { changed: r.changed, skipped: r.skipped }));
        else if (r && r.unchanged > 0) notify.info(t("spacePages.bulkVisibilityUnchanged", { changed: r.changed, unchanged: r.unchanged }));
        else notify.success(t(makePrivate ? "spacePages.bulkPrivateDone" : "spacePages.bulkUnprivateDone", { count: r?.changed ?? 0 }));
      },
      onError: () => notify.error(t("toast.actionFailed")),
    });
  };

  // #511 slice 4: export the selection. Read-only, so it just runs; the server view-gates each page and a
  // 413 means the archive blew the size budget (its own message, not a generic failure).
  const [exporting, setExporting] = useState(false);
  const runBulkExport = async () => {
    const ids = [...selected];
    setExporting(true);
    const status = await downloadSelectionExport(token ?? "", spaceId, ids);
    setExporting(false);
    if (status >= 200 && status < 300) { clearSelection(); notify.success(t("spacePages.bulkExportDone", { count: ids.length })); }
    else if (status === 413) notify.error(t("spacePages.exportTooLarge"));
    else notify.error(t("toast.actionFailed"));
  };

  const n = selected.size;

  return (
    // #439: widened (was 720px) + table-fixed below — the auto layout let long titles squeeze the
    // status column until its badges wrapped one glyph per line.
    <div className="max-w-[920px] p-6" data-testid="space-pages">
      <h2 className="mt-0">{t("spacePages.title")}</h2>
      {pages.isLoading && <p className="text-sm text-fg-dim">{t("common.loading")}</p>}
      {!pages.isLoading && rows.length === 0 && <p className="text-sm text-fg-dim">{t("spacePages.empty")}</p>}

      {/* #511: the bulk action bar appears only with a selection. Delete is red-at-rest (#504 posture) and
          confirmed before it runs (the ConfirmDialog's onConfirm is the guard the #510 policy checks). */}
      {n > 0 && (
        <div className="mb-3 flex items-center gap-3 rounded-md border border-border bg-panel p-2" data-testid="space-pages-bulkbar">
          <span className="text-sm text-fg-dim" data-testid="bulk-selected-count">{t("spacePages.selectedCount", { count: n })}</span>
          <Button variant="default" size="sm" data-testid="bulk-publish" disabled={bulkPublish.isPending} onClick={runBulkPublish}>
            <Upload size={14} /> {t("spacePages.publish")}
          </Button>
          <Button variant="default" size="sm" data-testid="bulk-private" disabled={bulkVisibility.isPending} onClick={() => setPrivateConfirmOpen(true)}>
            <Lock size={14} /> {t("spacePages.makePrivate")}
          </Button>
          <Button variant="default" size="sm" data-testid="bulk-unprivate" disabled={bulkVisibility.isPending} onClick={() => runBulkVisibility(false)}>
            <LockOpen size={14} /> {t("spacePages.clearPrivate")}
          </Button>
          <Button variant="default" size="sm" data-testid="bulk-export" disabled={exporting} onClick={runBulkExport}>
            <Download size={14} /> {t("spacePages.exportSelected")}
          </Button>
          <Button variant="danger" size="sm" data-testid="bulk-delete" onClick={() => setConfirmOpen(true)}>
            <Trash2 size={14} /> {t("common.delete")}
          </Button>
          <Button variant="ghost" size="sm" onClick={clearSelection}>{t("spacePages.clearSelection")}</Button>
        </div>
      )}

      {rows.length > 0 && (
        <div className="overflow-x-auto" data-testid="space-pages-scroller">
        <table className="w-full min-w-[500px] table-fixed border-collapse text-sm [&_td]:border-b [&_td]:border-border [&_td]:p-2 [&_th]:border-b [&_th]:border-border [&_th]:px-2 [&_th]:py-1.5 [&_th]:text-left [&_th]:text-[11px] [&_th]:font-semibold [&_th]:uppercase [&_th]:tracking-[0.03em] [&_th]:text-fg-dim">
          <thead>
            <tr>
              <th className="w-[32px]">
                <input type="checkbox" checked={allSelected} onChange={toggleAll}
                  aria-label={t("spacePages.selectAll")} data-testid="bulk-select-all" className="cursor-pointer" />
              </th>
              {/* table-fixed: the title column takes the REMAINING width (and truncates); the
                  status/count columns are fixed and never wrap (#439). */}
              <th className="min-w-[160px] whitespace-nowrap">{t("spacePages.title")}</th>
              <th className="w-[132px] whitespace-nowrap">{t("spacePages.status")}</th>
              <th className="w-[88px] whitespace-nowrap !text-right">{t("spacePages.grants")}</th>
              <th className="w-[88px] whitespace-nowrap !text-right">{t("spacePages.links")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.id} className="cursor-pointer" data-testid="space-page-row"
                data-selected={selected.has(p.id) ? "true" : undefined}>
                <td onClick={(e) => e.stopPropagation()}>
                  <input type="checkbox" checked={selected.has(p.id)} onChange={() => toggle(p.id)}
                    aria-label={t("spacePages.selectRow")} data-testid="bulk-select-row" className="cursor-pointer" />
                </td>
                <td onClick={() => navigate(`/p/${p.id}`)}><div className="truncate" data-tip={p.title || undefined}>{p.title || t("common.untitled")}</div></td>
                <td className="whitespace-nowrap" onClick={() => navigate(`/p/${p.id}`)}>
                  {!p.published
                    ? <span className={`${chip} border-border text-fg-dim`}>{t("spacePages.draft")}</span>
                    : p.hasUnpublishedChanges
                      ? <span className={`${chip} border-[color-mix(in_srgb,var(--accent)_50%,var(--border))] text-[var(--accent)]`}>{t("spacePages.unpublished")}</span>
                      : <span className="text-sm text-fg-dim">{t("spacePages.published")}</span>}
                </td>
                <td className="w-[72px] text-right" onClick={() => navigate(`/p/${p.id}`)}>{p.grantCount}</td>
                <td className="w-[72px] text-right" onClick={() => navigate(`/p/${p.id}`)}>{p.linkCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}

      {/* #511 / ADR-185 point 2+3: the confirm names the count AND that nested pages go too (delete
          cascades to the subtree — never a silent orphan/expansion); a large selection escalates to
          type-to-confirm. #504 danger tone. */}
      <ConfirmDialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={runBulkDelete}
        title={t("spacePages.bulkDeleteTitle")}
        message={t("spacePages.bulkDeleteConfirm", { count: n })}
        confirmLabel={t("common.delete")}
        confirmTestId="bulk-delete-confirm"
        typedConfirmText={n > TYPE_CONFIRM_THRESHOLD ? "delete" : undefined}
      />

      {/* #511 the one-way-door confirm. Not "are you sure" theatre — it names the specific
          consequence the model imposes (the caller loses `share` on pages that are not their own and cannot
          undo this), which is the only thing that makes the action safe to offer from a whole-space list. */}
      <ConfirmDialog
        open={privateConfirmOpen}
        onClose={() => setPrivateConfirmOpen(false)}
        onConfirm={() => runBulkVisibility(true)}
        title={t("spacePages.bulkPrivateTitle")}
        message={t("spacePages.bulkPrivateConfirm", { count: n })}
        confirmLabel={t("spacePages.makePrivate")}
        confirmTestId="bulk-private-confirm"
      />
    </div>
  );
}
