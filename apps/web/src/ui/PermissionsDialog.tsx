import { useState } from "react";
import { Dialog } from "@ark-ui/react/dialog";
import { Portal } from "@ark-ui/react/portal";
import { usePageAccess, useGrantAccess, useRevokeAccess, type PageRelation } from "../data/queries";
import styles from "./dialogs.module.css";

// Per-page permission management (Phase 4c). Shown only to managers (the open page's
// canManage); the server re-checks `manage` on every access call. Granting view/edit
// is also how you INVITE someone to an unpublished (draft) page — a draft is private
// to the people listed here until it is published.
export function PermissionsDialog({ pageId, open, onClose }: { pageId: string; open: boolean; onClose: () => void }) {
  const { data: grants } = usePageAccess(pageId, open);
  const grant = useGrantAccess(pageId);
  const revoke = useRevokeAccess(pageId);
  const [sub, setSub] = useState("");
  const [relation, setRelation] = useState<PageRelation>("view");

  const add = () => {
    const s = sub.trim();
    if (!s) return;
    grant.mutate({ grantee: `user:${s}`, relation });
    setSub("");
  };
  const label = (g: string) => g.startsWith("group:") ? `${g.replace(/^group:/, "").replace(/#member$/, "")} (group)` : g.replace(/^user:/, "");

  return (
    <Dialog.Root open={open} onOpenChange={(d) => !d.open && onClose()}>
      <Portal>
        <Dialog.Backdrop className={styles.backdrop} />
        <Dialog.Positioner className={styles.positioner}>
          <Dialog.Content className={styles.content} data-testid="permissions-dialog">
            <Dialog.Title className={styles.title}>Permissions</Dialog.Title>
            <Dialog.Description className={styles.message}>
              Grant members access to this page. An unpublished page is private to the people listed here.
            </Dialog.Description>

            <div className={styles.shareRow}>
              <input className={styles.linkUrl} data-testid="grant-sub" aria-label="Member" placeholder="member id" value={sub} onChange={(e) => setSub(e.target.value)} />
              <select className={styles.select} aria-label="Relation" data-testid="grant-relation" value={relation} onChange={(e) => setRelation(e.target.value as PageRelation)}>
                <option value="view">view</option>
                <option value="edit">edit</option>
                <option value="manage">manage</option>
              </select>
              <button type="button" className={`${styles.btn} ${styles.primary}`} data-testid="grant-add" disabled={grant.isPending} onClick={add}>Add</button>
            </div>

            <div className={styles.linkList} data-testid="grant-list">
              {(grants ?? []).map((g) => (
                <div key={`${g.grantee}:${g.relation}`} className={styles.linkItem} data-testid="grant-item">
                  <span className={styles.linkMeta}>{g.relation}</span>
                  <span className={styles.linkUrl} style={{ border: "none" }}>{label(g.grantee)}</span>
                  <button type="button" className={styles.iconBtn} aria-label="Revoke" data-testid="grant-revoke" onClick={() => revoke.mutate({ grantee: g.grantee, relation: g.relation })}>×</button>
                </div>
              ))}
              {(grants?.length ?? 0) === 0 && <p style={{ color: "var(--fg-dim)", fontSize: 12, margin: 0 }}>No direct grants yet.</p>}
            </div>

            <div className={styles.actions}>
              <button type="button" className={styles.btn} onClick={onClose}>Close</button>
            </div>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
