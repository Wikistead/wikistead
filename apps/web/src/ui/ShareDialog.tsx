import { useState } from "react";
import { Dialog } from "@ark-ui/react/dialog";
import { Portal } from "@ark-ui/react/portal";
import { Copy, Trash2 } from "lucide-react";
import { useShareLinks, useCreateShareLink, useRevokeShareLink } from "../data/queries";
import styles from "./dialogs.module.css";

const EXPIRY_OPTIONS: { label: string; seconds: number | null }[] = [
  { label: "Never", seconds: null },
  { label: "1 hour", seconds: 3600 },
  { label: "1 day", seconds: 86400 },
  { label: "7 days", seconds: 604800 },
];

// Member-facing share UI: create page links (view/edit, optional expiry), copy
// the URL, and revoke. The URL carries only the unguessable link id; the guest
// exchanges it for a short-lived token at the public landing endpoint.
export function ShareDialog({ pageId, onClose }: { pageId: string | null; onClose: () => void }) {
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
            <Dialog.Title className={styles.title}>Share page</Dialog.Title>

            <div className={styles.shareRow}>
              <select
                aria-label="Capability"
                className={styles.select}
                value={capability}
                onChange={(e) => setCapability(e.target.value as "view" | "edit")}
              >
                <option value="view">Can view</option>
                <option value="edit">Can edit</option>
              </select>
              <select
                aria-label="Expiry"
                className={styles.select}
                value={String(expiry)}
                onChange={(e) => setExpiry(e.target.value === "null" ? null : Number(e.target.value))}
              >
                {EXPIRY_OPTIONS.map((o) => (
                  <option key={o.label} value={String(o.seconds)}>
                    {o.label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className={`${styles.btn} ${styles.primary}`}
                data-testid="create-link"
                disabled={pageId === null || create.isPending}
                onClick={() => pageId && create.mutate({ pageId, capability, expiresInSeconds: expiry })}
              >
                Create link
              </button>
            </div>

            <div className={styles.linkList} data-testid="link-list">
              {links.isLoading ? (
                <div className={styles.message}>Loading…</div>
              ) : (links.data?.length ?? 0) === 0 ? (
                <div className={styles.message}>No active links.</div>
              ) : (
                links.data!.map((l) => (
                  <div key={l.id} className={styles.linkItem}>
                    <span className={styles.linkMeta}>
                      {l.capability === "edit" ? "Edit" : "View"}
                      {l.expiresAt ? ` · expires ${new Date(l.expiresAt).toLocaleString()}` : " · never expires"}
                    </span>
                    <input className={styles.linkUrl} readOnly value={linkUrl(l.id)} aria-label="Share URL" />
                    <button
                      type="button"
                      className={styles.iconBtn}
                      title="Copy URL"
                      onClick={() => {
                        navigator.clipboard?.writeText(linkUrl(l.id));
                        setCopied(l.id);
                      }}
                    >
                      <Copy size={14} />
                    </button>
                    <button
                      type="button"
                      className={styles.iconBtn}
                      title="Revoke"
                      data-testid="revoke-link"
                      onClick={() => pageId && revoke.mutate({ id: l.id, pageId })}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))
              )}
            </div>
            {copied && <div className={styles.copied}>Copied link to clipboard.</div>}

            <div className={styles.actions}>
              <button type="button" className={styles.btn} onClick={onClose}>
                Done
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
