import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Download, Paperclip, Trash2, Upload } from "lucide-react";
import { useSession } from "../session/SessionProvider";
import { RightPanel } from "../ui/RightPanel";
import { PanelRowsSkeleton, useDelayedFlag } from "../ui/Skeleton"; // #457 loading ≠ empty
import { ConfirmDialog } from "../ui/dialogs"; // #504: deleting an attachment is irreversible
import {
  useAttachments,
  useDeleteAttachment,
  usePageMeta,
  useUploadAttachment,
  fetchDownloadUrl,
} from "./useAttachments";

// #206: the right-panel chrome (width / bg / slide-in / header / close / Esc) is the shared RightPanel.
const iconBtn = "flex flex-none rounded border border-border p-[3px] text-fg-dim hover:bg-panel-2 hover:text-foreground";
const row = "flex items-center gap-2 py-1 text-[13px]";
const dim = "flex-none text-xs text-fg-dim";

function fmtSize(n: number | null): string {
  if (n == null) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

interface UploadState { name: string; status: "uploading" | "error"; message?: string }

// Page attachments (member-only chrome; NOT part of the canonical Y.Text). A right-side
// panel opened on demand from the ⋯ menu (no longer an always-on bottom bar). All
// authorization is server-side: upload needs `edit`, list/download `view`,
// delete `manage`. readOnly hides upload/delete (the server 403 is the real gate).
export function AttachmentsPanel({ pageId, readOnly, onClose }: { pageId: string; readOnly: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const { token } = useSession();
  const meta = usePageMeta(pageId);
  const spaceId = meta.data?.spaceId;
  const list = useAttachments(spaceId, pageId);
  const upload = useUploadAttachment(spaceId, pageId);
  const del = useDeleteAttachment(pageId);

  const [uploads, setUploads] = useState<UploadState[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  // #504: deleting an attachment destroys the stored object — red trigger + confirm naming the file.
  const [deleting, setDeleting] = useState<{ id: string; filename: string } | null>(null);

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
  // #457 row skeletons (delay-gated) while the list loads — "attachments are coming" must not
  // read as the "no attachments" empty wording below.
  const showSkeleton = useDelayedFlag(list.isLoading);

  return (
    <RightPanel
      testId="attachments-panel"
      title={<span className="inline-flex items-center gap-1"><Paperclip size={14} /> {t("attachments.header", { count })}</span>}
      onClose={onClose}
    >
      <div className="flex flex-col">
          {!readOnly && (
            <div className="py-1">
              <button type="button" className="inline-flex items-center gap-1 rounded border border-border bg-panel-2 px-2.5 py-1 text-[13px] text-foreground hover:bg-border" data-testid="attach-upload" onClick={() => fileRef.current?.click()}>
                <Upload size={14} /> {t("attachments.upload")}
              </button>
              <input ref={fileRef} type="file" multiple hidden onChange={(e) => onFiles(e.target.files)} />
            </div>
          )}

          {uploads.map((u) => (
            <div key={u.name} className={row}>
              <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">{u.name}</span>
              <span className={u.status === "error" ? "flex-none text-xs text-[var(--danger)]" : dim}>
                {u.status === "uploading" ? t("attachments.uploading") : t("attachments.failed", { msg: u.message ?? t("attachments.error") })}
              </span>
            </div>
          ))}

          {list.isLoading ? (
            showSkeleton ? <PanelRowsSkeleton testid="attachments-skeleton" /> : null
          ) : count === 0 && uploads.length === 0 ? (
            <div className={dim}>{t("attachments.empty")}</div>
          ) : (
            list.data!.map((a) => (
              <div key={a.id} className={row} data-testid="attach-item">
                <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap" data-tip={a.filename}>{a.filename}</span>
                <span className={dim}>{fmtSize(a.sizeBytes)}</span>
                <button type="button" className={iconBtn} data-tip={t("attachments.download")} data-testid="attach-download" onClick={() => onDownload(a.id)}>
                  <Download size={14} />
                </button>
                {!readOnly && (
                  // #504: red at rest (not only on hover) + confirm — the stored object is gone for good.
                  <button type="button" className="flex flex-none rounded border border-border p-[3px] text-destructive hover:bg-[color-mix(in_srgb,var(--danger)_12%,transparent)] hover:border-destructive" data-tip={t("attachments.delete")} data-testid="attach-delete" onClick={() => setDeleting({ id: a.id, filename: a.filename })}>
                    <Trash2 size={14} />
                  </button>
                )}
              </div>
            ))
          )}
      </div>
      {/* #504: the delete confirm — names the file, danger tone. */}
      <ConfirmDialog
        open={deleting !== null}
        message={deleting ? t("attachments.deleteConfirm", { filename: deleting.filename }) : ""}
        confirmTestId="attach-delete-confirm"
        onClose={() => setDeleting(null)}
        onConfirm={() => { if (deleting) del.mutate(deleting.id); setDeleting(null); }}
      />
    </RightPanel>
  );
}
