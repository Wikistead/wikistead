import { EditorView, minimalSetup } from "codemirror";
import { EditorState, type Compartment } from "@codemirror/state";
import { vim } from "@replit/codemirror-vim";
import { markdownExtension } from "./markdown-config";
import { yCollab } from "y-codemirror.next";
import type * as Y from "yjs";
import type { HocuspocusProvider } from "@hocuspocus/provider";
import { livePreview, livePreviewTheme, linkClicks, imageResolver, type ImageResolver } from "./live-preview/decorations";
import { commentHighlights, commentHighlightTheme } from "./live-preview/comment-highlights";
import { floatingToolbar, type ImageUploader } from "./live-preview/toolbar";
import { slashPalette } from "./live-preview/palette";
import { attachImageDrop } from "./live-preview/image-drop";
import { cmTheme } from "../styles/cm-theme";
import { remoteCursors } from "./remote-cursors";

// The single editing surface (Group C / Step I): Obsidian-style live preview bound to
// the canonical Y.Text. Rendered by default; the line/block under the cursor reveals
// raw markdown (reveal-on-cursor in decorations.ts) so it's editable in place. vim is
// an OPTIONAL keymap toggled via a Compartment owned by the caller — toggling it
// reconfigures in place (never remounts), so collab/presence are never dropped (#8
// invariant). vim() goes FIRST so its keymap takes precedence; with vim OFF the
// compartment is empty (pure live preview).
export function mountLivePreview(
  parent: HTMLElement,
  ytext: Y.Text,
  provider: HocuspocusProvider,
  opts: { readOnly?: boolean; resolveImageUrl?: ImageResolver; uploadImage?: ImageUploader; vim?: boolean; vimCompartment?: Compartment } = {},
): EditorView {
  // minimalSetup (no line numbers/gutters — this is a reading-style surface).
  const view = new EditorView({
    doc: ytext.toString(),
    extensions: [
      ...(opts.vimCompartment ? [opts.vimCompartment.of(opts.vim ? vim() : [])] : []),
      minimalSetup,
      cmTheme,
      EditorView.lineWrapping,
      // GFM base (tables) + fenced-code highlighting. The doc stays plain markdown.
      markdownExtension(),
      livePreviewTheme,
      livePreview,
      linkClicks,
      // Inline-comment anchor highlights (display-only; fed via setCommentRanges).
      commentHighlightTheme,
      commentHighlights,
      // Resolves wks-attachment image ids → fresh presigned URLs (member only).
      ...(opts.resolveImageUrl ? [imageResolver.of(opts.resolveImageUrl)] : []),
      yCollab(ytext, provider.awareness),
      remoteCursors, // #8: avatar+name flags (additive overlay; yCollab untouched)
      // Floating selection toolbar + slash command palette (editable surface only;
      // view guests get neither). container = the host so the hidden file input
      // survives CM's DOM reconcile.
      ...(!opts.readOnly ? [floatingToolbar({ uploadImage: opts.uploadImage, container: parent }), slashPalette()] : []),
      ...(opts.readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : []),
    ],
  });

  // Drag-and-drop image attach (editable surface only — needs an uploader).
  if (!opts.readOnly && opts.uploadImage) attachImageDrop(view, opts.uploadImage);

  const host = document.createElement("div");
  host.className = "lp-editor-host";
  host.appendChild(view.dom);
  parent.appendChild(host);

  return view;
}

// Read-only render of a page's PUBLISHED markdown (draft/publish model). Unlike
// mountLivePreview this is NOT collab-bound — view-capability users (and view share
// links) never join the collab room, so the live draft is never delivered to their
// browser; they only ever receive the published snapshot over HTTP. Same live-
// preview decorations + image resolver, no yCollab / comments / toolbar.
export function mountPublishedView(
  parent: HTMLElement,
  markdown: string,
  opts: { resolveImageUrl?: ImageResolver } = {},
): EditorView {
  const view = new EditorView({
    doc: markdown,
    extensions: [
      minimalSetup,
      cmTheme,
      EditorView.lineWrapping,
      markdownExtension(),
      livePreviewTheme,
      livePreview,
      linkClicks,
      ...(opts.resolveImageUrl ? [imageResolver.of(opts.resolveImageUrl)] : []),
      EditorState.readOnly.of(true),
      EditorView.editable.of(false),
    ],
  });
  const host = document.createElement("div");
  host.className = "lp-editor-host";
  host.appendChild(view.dom);
  parent.appendChild(host);
  return view;
}
