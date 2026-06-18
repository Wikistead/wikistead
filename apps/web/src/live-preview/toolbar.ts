import type { EditorView } from "@codemirror/view";
import {
  insertLink,
  setHeading,
  toggleBold,
  toggleBulletList,
  toggleInlineCode,
} from "./commands";

// Minimal insert toolbar for non-technical users. Framework-agnostic DOM so the
// editor surface stands alone now; the React chrome (next stage) can replace this
// with a <Toolbar/> calling the same command functions.
const BUTTONS: { label: string; title: string; run: (v: EditorView) => void }[] = [
  { label: "B", title: "Bold", run: toggleBold },
  { label: "H", title: "Heading", run: (v) => setHeading(v, 2) },
  { label: "• List", title: "Bullet list", run: toggleBulletList },
  { label: "</>", title: "Inline code", run: toggleInlineCode },
  { label: "Link", title: "Link", run: insertLink },
];

export function mountToolbar(parent: HTMLElement, getView: () => EditorView): HTMLElement {
  const bar = document.createElement("div");
  bar.className = "lp-toolbar";
  for (const { label, title, run } of BUTTONS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "lp-toolbar-btn";
    button.textContent = label;
    button.title = title;
    // mousedown + preventDefault keeps the editor selection/focus intact so the
    // command applies to the user's current selection.
    button.addEventListener("mousedown", (e) => {
      e.preventDefault();
      run(getView());
    });
    bar.appendChild(button);
  }
  parent.appendChild(bar);
  return bar;
}
