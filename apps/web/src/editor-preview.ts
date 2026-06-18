import type * as Y from "yjs";

// Non-technical surface. In the real app this is an Obsidian-style live-preview
// CodeMirror instance (syntax hidden + toolbar) bound to the SAME Y.Text via
// yCollab — giving cross-surface presence for free. For the PoC we render a
// read-through mirror to prove both surfaces observe one canonical document.
export function mountPreview(el: HTMLElement, ytext: Y.Text) {
  const render = () => { el.textContent = ytext.toString(); };
  render();
  ytext.observe(render);
  // TODO(phase: editor): replace with live-preview CodeMirror (decorations hide
  //   markdown syntax) + insert toolbar; bind with yCollab for shared presence.
}
