import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight, Download, Paperclip, Trash2, Upload } from "lucide-react";
import { useSession } from "../session/SessionProvider";
import {
  useAttachments,
  useDeleteAttachment,
  usePageMeta,
  useUploadAttachment,
  fetchDownloadUrl,
} from "./useAttachments";
import styles from "./AttachmentsPanel.module.css";

function fmtSize(n: number | null): string {
  if (n == null) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

interface UploadState { name: string; status: "uploading" | "error"; message?: string }

// Page attachments (member-only chrome; NOT part of the canonical Y.Text). All
// authorization is server-side: upload needs `edit`, list/download `view`,
// delete `manage`. readOnly hides upload/delete (the server 403 is the real gate).
export function AttachmentsPanel({ pageId, readOnly }: { pageId: string; readOnly: boolean }) {
  const { t } = useTranslation();
  const { token } = useSession();
  const meta = usePageMeta(pageId);
  const spaceId = meta.data?.spaceId;
  const list = useAttachments(spaceId, pageId);
  const upload = useUploadAttachment(spaceId, pageId);
  const del = useDeleteAttachment(pageId);

  const [open, setOpen] = useState(false);
  const [uploads, setUploads] = useState<UploadState[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  async function onFiles(files: FileList | null) {
    if (!files) return;
    for (const file of Array.from(files)) {
      setUploads((u) => [...u, { name: file.name, status: "uploading" }]);
      try {
        await upload.mutateAsync(file);
        setUploads((u) => u.filter((x) => x.name !== file.name));
      } catch (e) {
        // Do NOT auto-retry (avoids pending-orphan growth) — surface a clear,
        // per-file error; the user can retry manually. The backend GC reclaims
        // any presigned-but-unconfirmed orphan.
        setUploads((u) => u.map((x) => (x.name === file.name ? { ...x, status: "error", message: (e as Error).message } : x)));
      }
    }
    if (fileRef.current) fileRef.current.value = "";
  }

  async function onDownload(id: string) {
    // Always fetch a fresh presigned GET URL — never cache it (see useAttachments).
    const url = await fetchDownloadUrl(id, token);
    if (url) window.open(url, "_blank", "noopener");
  }

  const count = list.data?.length ?? 0;

  return (
    <div className={styles.panel} data-testid="attachments-panel">
      <button type="button" className={styles.header} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <ChevronRight size={14} className={open ? styles.caretOpen : styles.caret} />
        <Paperclip size={14} />
        <span>{t("attachments.header", { count })}</span>
      </button>

      {open && (
        <div className={styles.body}>
          {!readOnly && (
            <div className={styles.uploadRow}>
              <button type="button" className={styles.uploadBtn} data-testid="attach-upload" onClick={() => fileRef.current?.click()}>
                <Upload size={14} /> {t("attachments.upload")}
              </button>
              <input ref={fileRef} type="file" multiple hidden onChange={(e) => onFiles(e.target.files)} />
            </div>
          )}

          {uploads.map((u) => (
            <div key={u.name} className={styles.item}>
              <span className={styles.name}>{u.name}</span>
              <span className={u.status === "error" ? styles.error : styles.dim}>
                {u.status === "uploading" ? t("attachments.uploading") : t("attachments.failed", { msg: u.message ?? t("attachments.error") })}
              </span>
            </div>
          ))}

          {list.isLoading ? (
            <div className={styles.dim}>{t("common.loading")}</div>
          ) : count === 0 && uploads.length === 0 ? (
            <div className={styles.dim}>{t("attachments.empty")}</div>
          ) : (
            list.data!.map((a) => (
              <div key={a.id} className={styles.item} data-testid="attach-item">
                <span className={styles.name} title={a.filename}>{a.filename}</span>
                <span className={styles.dim}>{fmtSize(a.sizeBytes)}</span>
                <button type="button" className={styles.iconBtn} title={t("attachments.download")} data-testid="attach-download" onClick={() => onDownload(a.id)}>
                  <Download size={14} />
                </button>
                {!readOnly && (
                  <button type="button" className={styles.iconBtn} title={t("attachments.delete")} onClick={() => del.mutate(a.id)}>
                    <Trash2 size={14} />
                  </button>
                )}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
