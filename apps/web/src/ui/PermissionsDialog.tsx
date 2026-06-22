import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Dialog } from "@ark-ui/react/dialog";
import { Portal } from "@ark-ui/react/portal";
import { usePageAccess, useGrantAccess, useRevokeAccess, type PageRelation } from "../data/queries";
import { notify } from "./toast";
import styles from "./dialogs.module.css";

// Per-page permission management (Phase 4c). Shown only to managers (the open page's
// canManage); the server re-checks `manage` on every access call. Granting view/edit
// is also how you INVITE someone to an unpublished (draft) page — a draft is private
// to the people listed here until it is published.
export function PermissionsDialog({ pageId, open, onClose }: { pageId: string; open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const { data: grants } = usePageAccess(pageId, open);
  const grant = useGrantAccess(pageId);
  const revoke = useRevokeAccess(pageId);
  const [sub, setSub] = useState("");
  const [relation, setRelation] = useState<PageRelation>("view");

  const add = () => {
    const s = sub.trim();
    if (!s) return;
    grant.mutate({ grantee: `user:${s}`, relation }, {
      onSuccess: () => notify.success(t("toast.accessGranted")),
      onError: () => notify.error(t("toast.actionFailed")),
    });
    setSub("");
  };
  const label = (g: string) => g.startsWith("group:") ? `${g.replace(/^group:/, "").replace(/#member$/, "")} (${t("permissions.group")})` : g.replace(/^user:/, "");

  return (
    <Dialog.Root open={open} onOpenChange={(d) => !d.open && onClose()}>
      <Portal>
        <Dialog.Backdrop className={styles.backdrop} />
        <Dialog.Positioner className={styles.positioner}>
          <Dialog.Content className={styles.content} data-testid="permissions-dialog">
            <Dialog.Title className={styles.title}>{t("permissions.title")}</Dialog.Title>
            <Dialog.Description className={styles.message}>{t("permissions.body")}</Dialog.Description>

            <div className={styles.shareRow}>
              <input className={styles.linkUrl} data-testid="grant-sub" aria-label={t("permissions.member")} placeholder={t("permissions.memberPlaceholder")} value={sub} onChange={(e) => setSub(e.target.value)} />
              <select className={styles.select} aria-label={t("permissions.relation")} data-testid="grant-relation" value={relation} onChange={(e) => setRelation(e.target.value as PageRelation)}>
                <option value="view">{t("permissions.view")}</option>
                <option value="edit">{t("permissions.edit")}</option>
                <option value="manage">{t("permissions.manage")}</option>
              </select>
              <button type="button" className={`${styles.btn} ${styles.primary}`} data-testid="grant-add" disabled={grant.isPending} onClick={add}>{t("permissions.add")}</button>
            </div>

            <div className={styles.linkList} data-testid="grant-list">
              {(grants ?? []).map((g) => (
                <div key={`${g.grantee}:${g.relation}`} className={styles.linkItem} data-testid="grant-item">
                  <span className={styles.linkMeta}>{g.relation}</span>
                  <span className={styles.linkUrl} style={{ border: "none" }}>{label(g.grantee)}</span>
                  <button type="button" className={styles.iconBtn} data-danger="" aria-label={t("permissions.revoke")} data-testid="grant-revoke" onClick={() => revoke.mutate({ grantee: g.grantee, relation: g.relation }, {
                    onSuccess: () => notify.success(t("toast.accessRevoked")),
                    onError: () => notify.error(t("toast.actionFailed")),
                  })}>×</button>
                </div>
              ))}
              {(grants?.length ?? 0) === 0 && <p style={{ color: "var(--fg-dim)", fontSize: 12, margin: 0 }}>{t("permissions.empty")}</p>}
            </div>

            <div className={styles.actions}>
              <button type="button" className={styles.btn} onClick={onClose}>{t("common.close")}</button>
            </div>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
