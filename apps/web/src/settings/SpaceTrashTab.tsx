import { useState } from "react";
import { ListBox } from "../ui/list-rows";
import { useOutletContext } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useSpaceTrash, useRestorePage, usePurgePage, type TrashEntry } from "../data/queries";
import { Button } from "../ui/Button";
import { ConfirmDialog } from "../ui/dialogs";
import { notify } from "../ui/toast";

interface SpaceCtx { spaceId: string; name: string }

// #411 / ADR-153: the space trash — trashed subtree ROOTS, restorable for 30 days, then purged by
// retention. The server lists only entries the caller can manage (omit-on-deny), so this table never
// shows a page outside the manager's authority; restore/purge re-check manage server-side regardless.
export function SpaceTrashTab() {
  const { t } = useTranslation();
  const { spaceId } = useOutletContext<SpaceCtx>();
  const trash = useSpaceTrash(spaceId);
  const restore = useRestorePage();
  const purge = usePurgePage();
  const [purging, setPurging] = useState<TrashEntry | null>(null);

  const onRestore = (e: TrashEntry) =>
    restore.mutate({ pageId: e.id, spaceId }, {
      onSuccess: (r) => notify.success(t(r?.reparented ? "spaceTrash.restoredReparented" : "spaceTrash.restored")),
      onError: () => notify.error(t("toast.actionFailed")),
    });

  return (
    <div className="max-w-[720px] p-6" data-testid="space-trash">
      <h2 className="mt-0">{t("spaceTrash.title")}</h2>
      <p className="text-sm text-fg-dim">{t("spaceTrash.hint")}</p>
      {trash.isLoading && <p className="text-sm text-fg-dim">{t("common.loading")}</p>}
      {!trash.isLoading && (trash.data?.length ?? 0) === 0 && (
        <p className="text-sm text-fg-dim" data-testid="space-trash-empty">{t("spaceTrash.empty")}</p>
      )}

      {(trash.data?.length ?? 0) > 0 && (
        <ListBox>
          {/* #623 slice 10: the shared box from #639 — the same 26rem everywhere, so a long list
              scrolls inside itself instead of growing the page. The server bound landed in slice 4; the
              container waited until #639 settled, so this did not become a second one. */}
          <table className="w-full border-collapse text-sm [&_td]:border-b [&_td]:border-border [&_td]:p-2 [&_th]:border-b [&_th]:border-border [&_th]:px-2 [&_th]:py-1.5 [&_th]:text-left [&_th]:text-[11px] [&_th]:font-semibold [&_th]:uppercase [&_th]:tracking-[0.03em] [&_th]:text-fg-dim">
            <thead>
              <tr>
                <th>{t("spaceTrash.page")}</th>
                <th className="w-[160px]">{t("spaceTrash.deletedAt")}</th>
                <th className="w-[200px]"></th>
              </tr>
            </thead>
            <tbody>
              {trash.data!.map((e) => (
                <tr key={e.id} data-testid="space-trash-row">
                  <td>
                    {e.title || t("common.untitled")}
                    {e.descendants > 0 && (
                      <span className="ml-2 text-xs text-fg-dim">{t("spaceTrash.withDescendants", { count: e.descendants })}</span>
                    )}
                  </td>
                  <td className="text-fg-dim">{new Date(e.deletedAt).toLocaleDateString()}</td>
                  <td className="text-right">
                    <Button variant="default" size="sm" className="mr-2" disabled={restore.isPending} data-testid={`trash-restore-${e.id}`}
                      onClick={() => onRestore(e)}>{t("spaceTrash.restore")}</Button>
                    <Button variant="dangerGhost" size="sm" disabled={purge.isPending} data-testid={`trash-purge-${e.id}`}
                      onClick={() => setPurging(e)}>{t("spaceTrash.purge")}</Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </ListBox>
      )}

      <ConfirmDialog
        open={purging !== null}
        title={t("spaceTrash.purgeConfirmTitle")}
        message={t("spaceTrash.purgeConfirm", { name: purging?.title || t("common.untitled") })}
        confirmLabel={t("spaceTrash.purge")}
        tone="danger"
        // #504: a purge destroys the whole trashed subtree — type-to-confirm, page delete-forever parity.
        typedConfirmText={purging?.title || t("common.untitled")}
        confirmTestId="trash-purge-confirm"
        onClose={() => setPurging(null)}
        onConfirm={() => {
          if (purging) {
            purge.mutate({ pageId: purging.id, spaceId }, {
              onSuccess: () => notify.success(t("toast.pageDeleted")),
              onError: () => notify.error(t("toast.actionFailed")),
            });
          }
          setPurging(null);
        }}
      />
    </div>
  );
}
