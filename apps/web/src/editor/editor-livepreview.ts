import { EditorView, minimalSetup } from "codemirror";
import { EditorState } from "@codemirror/state";
import { markdownExtension } from "./markdown-config";
import { yCollab } from "y-codemirror.next";
import type * as Y from "yjs";
import type { HocuspocusProvider } from "@hocuspocus/provider";
import { livePreview, livePreviewTheme, imageResolver, type ImageResolver } from "./live-preview/decorations";
import { commentHighlights, commentHighlightTheme } from "./live-preview/comment-highlights";
import { mountToolbar, type ImageUploader } from "./live-preview/toolbar";
import { attachImageDrop } from "./live-preview/image-drop";

// Non-technical surface: Obsidian-style live preview bound to the SAME canonical
// Y.Text and SAME awareness as the vim surface. No vim, no CRDT bridge. Both
// surfaces share one Y.Text, so edits flow both ways and cross-surface presence
// (a collaborator's caret showing on both panes) works for free — see
// live-preview/decorations.ts for the display-only / offset-invariant invariant.
export function mountLivePreview(
  parent: HTMLElement,
  ytext: Y.Text,
  provider: HocuspocusProvider,
  opts: { readOnly?: boolean; resolveImageUrl?: ImageResolver; uploadImage?: ImageUploader } = {},
): EditorView {
  // minimalSetup (no line numbers/gutters — this is a reading-style surface).
  const view = new EditorView({
    doc: ytext.toString(),
    extensions: [
      minimalSetup,
      EditorView.lineWrapping,
      // GFM base (tables) + fenced-code highlighting. The doc stays plain markdown.
      markdownExtension(),
      livePreviewTheme,
      livePreview,
      // Inline-comment anchor highlights (display-only; fed via setCommentRanges).
      commentHighlightTheme,
      commentHighlights,
      // Resolves wks-attachment image ids → fresh presigned URLs (member only).
      ...(opts.resolveImageUrl ? [imageResolver.of(opts.resolveImageUrl)] : []),
      yCollab(ytext, provider.awareness),
      ...(opts.readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : []),
    ],
  });

  // View-capability guests get no insert toolbar.
  if (!opts.readOnly) mountToolbar(parent, () => view, { uploadImage: opts.uploadImage });
  // Drag-and-drop image attach (editable surface only — needs an uploader).
  if (!opts.readOnly && opts.uploadImage) attachImageDrop(view, opts.uploadImage);

  const host = document.createElement("div");
  host.className = "lp-editor-host";
  host.appendChild(view.dom);
  parent.appendChild(host);

  return view;
}
