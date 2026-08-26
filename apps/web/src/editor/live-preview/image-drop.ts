import type { EditorView } from "@codemirror/view";
import { insertImage, insertAttachment, type ImageUploader } from "./commands";
import { ApiError } from "../../data/apiClient";
import { notify } from "../../ui/toast";
import i18n from "../../i18n";

// #913: `upload(file)` failing (presign, the direct-to-storage PUT, or confirm) used to be
// swallowed silently — a broken reference was correctly never inserted, but nothing told the
// author their paste/drop did anything at all. A THROWN error is a real attempt that failed; an
// `ImageUploader` returning null without throwing (the member path's "page not resolved yet"
// guard) stays a silent decline, unchanged — that distinction is exactly why this no longer
// blanket-catches with `.catch(() => null)`.
//
// The PUT step's own failure carries only `upload failed (<status>)` in a plain Error message
// (useAttachments.ts's uploadAttachment) — a direct cross-origin fetch to storage, not apiFetch,
// so it never becomes an ApiError. Reading the status from both shapes is what lets a 413 from
// EITHER step (a size cap the presign endpoint enforces up front, or the one storage enforces on
// the PUT body) read the same to the person who pasted the file.
function uploadFailureStatus(err: unknown): number | null {
  if (err instanceof ApiError) return err.status;
  if (err instanceof Error) {
    const m = /\((\d{3})\)/.exec(err.message);
    if (m) return Number(m[1]);
  }
  return null;
}

/** Upload files in clipboard/drop order and insert their canonical attachment references. */
export async function uploadFiles(view: EditorView, upload: ImageUploader, files: File[]): Promise<void> {
  const failures: number[] = []; // one entry per failed file, its HTTP status (or null = unknown reason)
  for (let i = 0; i < files.length; i++) {
    const file = files[i]!;
    let res: { ref: string; alt: string } | null;
    try {
      res = await upload(file);
    } catch (err) {
      failures.push(uploadFailureStatus(err) ?? -1);
      continue;
    }
    if (!res) continue; // a silent decline (e.g. the page hasn't resolved yet) — not a failure to report
    if (file.type.startsWith("image/")) insertImage(view, res.alt, res.ref);
    else insertAttachment(view, res.alt || file.name, res.ref);
    if (files.length > 1 && i < files.length - 1) view.dispatch(view.state.replaceSelection("\n"));
  }
  if (failures.length === 0) return; // every file succeeded (or silently declined) — stay quiet, as before
  if (failures.length > 1) {
    notify.error(i18n.t("toast.uploadFailedCount", { count: failures.length }));
    return;
  }
  const status = failures[0];
  if (status === 413) notify.error(i18n.t("toast.uploadTooLarge"));
  else if (status === 415) notify.error(i18n.t("toast.uploadUnsupportedType"));
  else notify.error(i18n.t("toast.uploadFailed"));
}

// Drag-and-drop file attach (#273 / ADR-120 generalises the image-only path): dropping
// file(s) onto the editable preview uploads each via the host's uploader (presign → PUT →
// confirm) and inserts the stable reference at the drop point — an IMAGE inserts
// ![alt](wks-attachment:<id>), any OTHER file inserts the file-attachment link
// [name](wks-attachment:<id>) (the same shape minus the `!`). The canonical Y.Text holds
// only the id (never a presigned URL); the display layer renders the chip / download card /
// inline viewer by the SERVER-sniffed kind. Pasted files (clipboard) take the same path.
//
// Listeners are attached directly to the editor DOM in CAPTURE phase (rather than
// via EditorView.domEventHandlers) so we run before CodeMirror's own drag-drop
// handling and can stop it for file drops. Only the editable surface calls this
// (see mountLivePreview): a read-only view / view-capability guest has no uploader.
export function attachFileDrop(view: EditorView, upload: ImageUploader): void {
  const dom = view.dom;

  // Upload sequentially; each insert appends at the moving caret. Separate multiple
  // files with a newline so each parses as its own reference (and a standalone-line
  // attachment renders as the full card).
  const onDragOver = (event: DragEvent) => {
    // Must preventDefault on dragover for a drop to fire. Only intercept file drags
    // so text/selection drags keep CodeMirror's own behavior.
    //
    // #488: this one runs in the BUBBLE phase, unlike its siblings below. CodeMirror drops any event
    // that is already defaultPrevented when it reaches the editor (`eventBelongsToEditor`), so
    // preventing here in capture — before contentDOM sees it — made CM blind to the drag and its
    // drop cursor never appeared. Bubbling runs after contentDOM's listener and still cancels the
    // default in time for a drop to fire.
    if (Array.from(event.dataTransfer?.items ?? []).some((i) => i.kind === "file")) {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    }
  };

  const onDrop = (event: DragEvent) => {
    const files = Array.from(event.dataTransfer?.files ?? []);
    if (files.length === 0) return; // not a file drop → let CodeMirror handle it
    event.preventDefault();
    event.stopPropagation(); // keep CodeMirror from also handling this drop

    // Place the caret where the user dropped (fallback: current caret) — the same position the drop
    // cursor has been drawing under the pointer, so what the user aimed at is what they get.
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.head;
    view.dispatch({ selection: { anchor: pos } });
    view.focus();
    // #488: retract the drop cursor. CodeMirror clears it from its own `drop` observer, which sits
    // on contentDOM — and the stopPropagation above (what keeps CM from ALSO inserting the file's
    // text) means that observer never sees this drop, so the cursor would hang around afterwards.
    // A dragleave targeted at contentDOM is the same signal CM acts on when a drag leaves.
    view.contentDOM.dispatchEvent(new DragEvent("dragleave"));
    void uploadFiles(view, upload, files);
  };

  // #273: pasted files (e.g. a copied file from the OS file manager) upload the same way.
  // Text pastes (no files) are untouched — paste-linkify and CM's default keep handling them.
  const onPaste = (event: ClipboardEvent) => {
    const files = Array.from(event.clipboardData?.files ?? []);
    if (files.length === 0) return;
    event.preventDefault();
    event.stopPropagation();
    void uploadFiles(view, upload, files);
  };

  dom.addEventListener("dragover", onDragOver); // bubble — see the note in onDragOver (#488)
  dom.addEventListener("drop", onDrop, true); // capture — must beat CodeMirror's own file handling
  dom.addEventListener("paste", onPaste, true);
}

// Back-compat alias (the pre-#273 name) — same behaviour, images included.
export const attachImageDrop = attachFileDrop;
