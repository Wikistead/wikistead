import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Dialog } from "@ark-ui/react/dialog";
import { Portal } from "@ark-ui/react/portal";
import { Copy, Trash2 } from "lucide-react";
import { useShareLinks, useCreateShareLink, useRevokeShareLink } from "../data/queries";
import { notify } from "./toast";
import { Select } from "./Select";
import styles from "./dialogs.module.css";

const EXPIRY_OPTIONS: { key: string; seconds: number | null }[] = [
  { key: "shareDialog.never", seconds: null },
  { key: "shareDialog.oneHour", seconds: 3600 },
  { key: "shareDialog.oneDay", seconds: 86400 },
  { key: "shareDialog.sevenDays", seconds: 604800 },
];

// Member-facing share UI: create page links (view/edit, optional expiry), copy
// the URL, and revoke. The URL carries only the unguessable link id; the guest
// exchanges it for a short-lived token at the public landing endpoint.
export function ShareDialog({ pageId, onClose }: { pageId: string | null; onClose: () => void }) {
  const { t } = useTranslation();
  const open = pageId !== null;
  const links = useShareLinks(pageId ?? "", open);
  const create = useCreateShareLink();
  const revoke = useRevokeShareLink();

  const [capability, setCapability] = useState<"view" | "edit">("view");
  const [expiry, setExpiry] = useState<number | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const linkUrl = (id: string) => `${location.origin}/share/${id}`;

  return (
    <Dialog.Root open={open} onOpenChange={(d) => !d.open && onClose()}>
      <Portal>
        <Dialog.Backdrop className={styles.backdrop} />
        <Dialog.Positioner className={styles.positioner}>
          <Dialog.Content className={styles.content} data-testid="share-dialog">
            <Dialog.Title className={styles.title}>{t("shareDialog.title")}</Dialog.Title>

            <div className={styles.shareRow}>
              <Select
                value={capability}
                onChange={(v) => setCapability(v as "view" | "edit")}
                ariaLabel={t("shareDialog.capability")}
                testId="share-capability"
                size="sm"
                options={[
                  { value: "view", label: t("shareDialog.canView") },
                  { value: "edit", label: t("shareDialog.canEdit") },
                ]}
              />
              <Select
                value={String(expiry)}
                onChange={(v) => setExpiry(v === "null" ? null : Number(v))}
                ariaLabel={t("shareDialog.expiry")}
                size="sm"
                options={EXPIRY_OPTIONS.map((o) => ({ value: String(o.seconds), label: t(o.key) }))}
              />
              <button
                type="button"
                className={`${styles.btn} ${styles.primary}`}
                data-testid="create-link"
                disabled={pageId === null || create.isPending}
                onClick={() => pageId && create.mutate({ pageId, capability, expiresInSeconds: expiry }, {
                  onSuccess: () => notify.success(t("toast.linkCreated")),
                  onError: () => notify.error(t("toast.actionFailed")),
                })}
              >
                {t("shareDialog.create")}
              </button>
            </div>

            <div className={styles.linkList} data-testid="link-list">
              {links.isLoading ? (
                <div className={styles.message}>{t("common.loading")}</div>
              ) : (links.data?.length ?? 0) === 0 ? (
                <div className={styles.message}>{t("shareDialog.noLinks")}</div>
              ) : (
                links.data!.map((l) => (
                  <div key={l.id} className={styles.linkItem}>
                    <span className={styles.linkMeta}>
                      {l.capability === "edit" ? t("shareDialog.edit") : t("shareDialog.view")}
                      {l.expiresAt ? ` · ${t("shareDialog.expires", { when: new Date(l.expiresAt).toLocaleString() })}` : ` · ${t("shareDialog.neverExpires")}`}
                    </span>
                    <input className={styles.linkUrl} readOnly value={linkUrl(l.id)} aria-label={t("shareDialog.shareUrl")} />
                    <button
                      type="button"
                      className={styles.iconBtn}
                      title={t("shareDialog.copyUrl")}
                      onClick={() => {
                        navigator.clipboard?.writeText(linkUrl(l.id));
                        setCopied(l.id);
                        notify.success(t("toast.copied"));
                      }}
                    >
                      <Copy size={14} />
                    </button>
                    <button
                      type="button"
                      className={styles.iconBtn}
                      data-danger=""
                      title={t("shareDialog.revoke")}
                      data-testid="revoke-link"
                      onClick={() => pageId && revoke.mutate({ id: l.id, pageId }, {
                        onSuccess: () => notify.success(t("toast.linkRevoked")),
                        onError: () => notify.error(t("toast.actionFailed")),
                      })}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))
              )}
            </div>
            {copied && <div className={styles.copied}>{t("shareDialog.copied")}</div>}

            <div className={styles.actions}>
              <button type="button" className={styles.btn} onClick={onClose}>
                {t("shareDialog.done")}
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
