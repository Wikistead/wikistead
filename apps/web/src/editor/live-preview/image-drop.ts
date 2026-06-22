import type { EditorView } from "@codemirror/view";
import { insertImage } from "./commands";
import type { ImageUploader } from "./toolbar";

// Drag-and-drop image attach: dropping image file(s) onto the editable preview
// uploads each via the host's uploader (presign → PUT → confirm) and inserts the
// stable ![alt](wks-attachment:<id>) reference at the drop point — the same path as
// the toolbar Image button, so the canonical Y.Text holds only the id (never a
// presigned URL). Non-image drops fall through to CodeMirror's default handling.
//
// Listeners are attached directly to the editor DOM in CAPTURE phase (rather than
// via EditorView.domEventHandlers) so we run before CodeMirror's own drag-drop
// handling and can stop it for image files. Only the editable surface calls this
// (see mountLivePreview): a read-only view / view-capability guest has no uploader.
export function attachImageDrop(view: EditorView, upload: ImageUploader): void {
  const dom = view.dom;

  const onDragOver = (event: DragEvent) => {
    // Must preventDefault on dragover for a drop to fire. Only intercept file drags
    // so text/selection drags keep CodeMirror's own behavior.
    if (Array.from(event.dataTransfer?.items ?? []).some((i) => i.kind === "file")) {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    }
  };

  const onDrop = (event: DragEvent) => {
    const files = Array.from(event.dataTransfer?.files ?? []).filter((f) => f.type.startsWith("image/"));
    if (files.length === 0) return; // not an image drop → let CodeMirror handle it
    event.preventDefault();
    event.stopPropagation(); // keep CodeMirror from also handling this drop

    // Place the caret where the user dropped (fallback: current caret).
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.head;
    view.dispatch({ selection: { anchor: pos } });
    view.focus();

    // Upload sequentially; each insert appends at the moving caret. Separate
    // multiple images with a newline so each parses as its own image.
    void (async () => {
      for (let i = 0; i < files.length; i++) {
        const res = await upload(files[i]!).catch(() => null);
        if (!res) continue;
        insertImage(view, res.alt, res.ref);
        if (files.length > 1 && i < files.length - 1) view.dispatch(view.state.replaceSelection("\n"));
      }
    })();
  };

  dom.addEventListener("dragover", onDragOver, true);
  dom.addEventListener("drop", onDrop, true);
}
