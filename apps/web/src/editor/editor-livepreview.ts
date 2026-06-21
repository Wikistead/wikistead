import { EditorView, minimalSetup } from "codemirror";
import { EditorState } from "@codemirror/state";
import { markdownExtension } from "./markdown-config";
import { yCollab } from "y-codemirror.next";
import type * as Y from "yjs";
import type { HocuspocusProvider } from "@hocuspocus/provider";
import { livePreview, livePreviewTheme } from "./live-preview/decorations";
import { mountToolbar } from "./live-preview/toolbar";

// Non-technical surface: Obsidian-style live preview bound to the SAME canonical
// Y.Text and SAME awareness as the vim surface. No vim, no CRDT bridge. Both
// surfaces share one Y.Text, so edits flow both ways and cross-surface presence
// (a collaborator's caret showing on both panes) works for free — see
// live-preview/decorations.ts for the display-only / offset-invariant invariant.
export function mountLivePreview(
  parent: HTMLElement,
  ytext: Y.Text,
  provider: HocuspocusProvider,
  opts: { readOnly?: boolean } = {},
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
      yCollab(ytext, provider.awareness),
      ...(opts.readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : []),
    ],
  });

  // View-capability guests get no insert toolbar.
  if (!opts.readOnly) mountToolbar(parent, () => view);

  const host = document.createElement("div");
  host.className = "lp-editor-host";
  host.appendChild(view.dom);
  parent.appendChild(host);

  return view;
}
