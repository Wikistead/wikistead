import type { EditorView } from "@codemirror/view";
import i18n from "../../i18n";
import {
  insertImage,
  insertLink,
  setHeading,
  toggleBold,
  toggleBulletList,
  toggleInlineCode,
} from "./commands";

// Uploads a chosen image file and returns the reference + alt to insert (or null
// to cancel/fail). Provided by the host (it knows the page + auth); omitted = no
// image button (e.g. guests, or surfaces without an uploader).
export type ImageUploader = (file: File) => Promise<{ ref: string; alt: string } | null>;

// Minimal insert toolbar for non-technical users. Framework-agnostic DOM so the
// editor surface stands alone now; the React chrome (next stage) can replace this
// with a <Toolbar/> calling the same command functions.
// title is an i18n key resolved at mount time (i18n.t) — the labels are symbols.
const BUTTONS: { label: string; titleKey: string; run: (v: EditorView) => void }[] = [
  { label: "B", titleKey: "lpToolbar.bold", run: toggleBold },
  { label: "H", titleKey: "lpToolbar.heading", run: (v) => setHeading(v, 2) },
  { label: "• List", titleKey: "lpToolbar.bulletList", run: toggleBulletList },
  { label: "</>", titleKey: "lpToolbar.inlineCode", run: toggleInlineCode },
  { label: "Link", titleKey: "lpToolbar.link", run: insertLink },
];

export function mountToolbar(
  parent: HTMLElement,
  getView: () => EditorView,
  opts: { uploadImage?: ImageUploader } = {},
): HTMLElement {
  const bar = document.createElement("div");
  bar.className = "lp-toolbar";
  for (const { label, titleKey, run } of BUTTONS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "lp-toolbar-btn";
    button.textContent = label;
    button.title = i18n.t(titleKey);
    // mousedown + preventDefault keeps the editor selection/focus intact so the
    // command applies to the user's current selection.
    button.addEventListener("mousedown", (e) => {
      e.preventDefault();
      run(getView());
    });
    bar.appendChild(button);
  }

  // Image button: opens a hidden file input; on pick, upload then insert the
  // ![alt](wks-attachment:<id>) reference at the caret.
  if (opts.uploadImage) {
    const upload = opts.uploadImage;
    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = "image/*";
    fileInput.style.display = "none";
    fileInput.setAttribute("data-testid", "lp-image-input");
    fileInput.addEventListener("change", () => {
      const file = fileInput.files?.[0];
      fileInput.value = ""; // allow re-picking the same file
      if (!file) return;
      void upload(file).then((res) => {
        if (res) insertImage(getView(), res.alt, res.ref);
      });
    });
    const imgButton = document.createElement("button");
    imgButton.type = "button";
    imgButton.className = "lp-toolbar-btn";
    imgButton.textContent = "Image";
    imgButton.title = i18n.t("lpToolbar.image");
    imgButton.setAttribute("data-testid", "lp-image-btn");
    imgButton.addEventListener("mousedown", (e) => {
      e.preventDefault();
      fileInput.click();
    });
    bar.appendChild(imgButton);
    bar.appendChild(fileInput);
  }

  parent.appendChild(bar);
  return bar;
}
