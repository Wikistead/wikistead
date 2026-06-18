import { EditorView, basicSetup } from "codemirror";
import { markdown } from "@codemirror/lang-markdown";
import { vim } from "@replit/codemirror-vim";
import { yCollab } from "y-codemirror.next";
import type * as Y from "yjs";
import type { HocuspocusProvider } from "@hocuspocus/provider";

// vim user's surface: markdown source + (vim keymap) bound directly to Y.Text.
// Presence cursors live in Y.Text offsets via yCollab/awareness.
export function mountSource(parent: HTMLElement, ytext: Y.Text, provider: HocuspocusProvider) {
  return new EditorView({
    parent,
    doc: ytext.toString(),
    extensions: [
      vim(), // remove this extension for the non-technical surface
      basicSetup,
      markdown(),
      yCollab(ytext, provider.awareness),
    ],
  });
}
