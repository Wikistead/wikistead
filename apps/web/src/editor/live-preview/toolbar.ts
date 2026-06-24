import { EditorView, ViewPlugin, showTooltip, type Tooltip } from "@codemirror/view";
import { StateField } from "@codemirror/state";
import i18n from "../../i18n";
import {
  insertImage,
  insertLink,
  toggleBold,
  toggleItalic,
  toggleStrikethrough,
  toggleInlineCode,
} from "./commands";

// Uploads a chosen image file and returns the reference + alt to insert (or null
// to cancel/fail). Provided by the host (it knows the page + auth); omitted = no
// image button (e.g. guests, or surfaces without an uploader).
export type ImageUploader = (file: File) => Promise<{ ref: string; alt: string } | null>;

// Layer-A (inline-span) format buttons ONLY — the selection bubble is the decoration
// entry for mouse/any-selection users. Block-level constructs (heading, list, table,
// divider) live in the slash palette, not here. title is an i18n key; labels are
// symbols. The command functions are inviolable (Y.Text edits) — this is chrome only.
const BUTTONS: { label: string; titleKey: string; run: (v: EditorView) => void }[] = [
  { label: "B", titleKey: "lpToolbar.bold", run: toggleBold },
  { label: "I", titleKey: "palette.italic", run: toggleItalic },
  { label: "S", titleKey: "palette.strikethrough", run: toggleStrikethrough },
  { label: "</>", titleKey: "lpToolbar.inlineCode", run: toggleInlineCode },
  { label: "Link", titleKey: "lpToolbar.link", run: insertLink },
];

function mkButton(label: string, title: string, run: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "lp-toolbar-btn";
  button.textContent = label;
  button.title = title;
  // mousedown + preventDefault keeps the editor selection/focus intact so the command
  // applies to the user's current selection (and the selection bubble stays up).
  button.addEventListener("mousedown", (e) => { e.preventDefault(); run(); });
  return button;
}

// Notion/Medium-style FLOATING selection toolbar: a small bubble shown above the
// current text selection (and hidden when there is none) — no always-on ribbon.
//
// Implemented as a CodeMirror TOOLTIP, not a DOM node we inject into the editor:
// CM owns/positions its tooltip layer (scroll-safe, reconciled across updates),
// whereas an element appended into view.dom is removed by CM on the next update.
// Purely presentational — it reads the LOCAL selection and dispatches the same
// command functions, never touching transactions/awareness, so collab + presence
// are untouched.
export function floatingToolbar(opts: { uploadImage?: ImageUploader; container?: HTMLElement } = {}) {
  // A single hidden file input, kept in the React-owned host container (which CM
  // never reconciles) so it persists across edits. The bubble's Image button — and
  // tests — drive it. Created/destroyed with the editor view.
  let fileInput: HTMLInputElement | null = null;
  const triggerImage = () => fileInput?.click();

  const inputPlugin = ViewPlugin.define((view) => {
    if (opts.uploadImage) {
      const upload = opts.uploadImage;
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "image/*";
      input.style.display = "none";
      input.setAttribute("data-testid", "lp-image-input");
      input.addEventListener("change", () => {
        const file = input.files?.[0];
        input.value = ""; // allow re-picking the same file
        if (!file) return;
        void upload(file).then((res) => { if (res) insertImage(view, res.alt, res.ref); });
      });
      (opts.container ?? document.body).appendChild(input);
      fileInput = input;
    }
    return { destroy() { fileInput?.remove(); fileInput = null; } };
  });

  function bubble(from: number, to: number): Tooltip {
    return {
      pos: from,
      end: to,
      above: true,
      strictSide: false,
      arrow: false,
      create: (view) => {
        const dom = document.createElement("div");
        dom.className = "lp-toolbar";
        dom.setAttribute("data-testid", "format-bubble");
        for (const { label, titleKey, run } of BUTTONS) dom.appendChild(mkButton(label, i18n.t(titleKey), () => run(view)));
        if (opts.uploadImage) {
          const imgBtn = mkButton("Image", i18n.t("lpToolbar.image"), triggerImage);
          imgBtn.setAttribute("data-testid", "lp-image-btn");
          dom.appendChild(imgBtn);
        }
        return { dom };
      },
    };
  }

  const bubbleField = StateField.define<readonly Tooltip[]>({
    create: () => [],
    update(value, tr) {
      if (!tr.docChanged && !tr.selection) return value;
      const sel = tr.state.selection.main;
      return sel.empty ? [] : [bubble(sel.from, sel.to)];
    },
    provide: (f) => showTooltip.computeN([f], (state) => state.field(f)),
  });

  return [inputPlugin, bubbleField];
}
