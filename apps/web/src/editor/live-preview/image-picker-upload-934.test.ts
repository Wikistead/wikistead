// @vitest-environment happy-dom
// #934: the slash-command image picker had NO .catch at all — `void upload(file).then(...)` — so a
// presign/PUT/confirm failure was an unhandled rejection with nothing shown to the author, while the
// SAME failure via drag or paste (#913) already reported a toast. This drives the picker's own hidden
// file input (the real DOM node `slashPalette` injects) through a `change` event, the way choosing a
// file from the native dialog does, and measures the same two signals #913's own test file uses: the
// document (was a broken reference inserted?) and `notify.error` (was the failure reported?).
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { slashPalette } from "./palette";
import { ApiError } from "../../data/apiClient";
import { notify } from "../../ui/toast";
import type { ImageUploader } from "./commands";

vi.mock("../../ui/toast", () => ({ notify: { success: vi.fn(), error: vi.fn() } }));

const file = (name = "shot.png", type = "image/png") => new File(["x"], name, { type });

function mountWithPicker(uploadImage: ImageUploader): { view: EditorView; input: HTMLInputElement; container: HTMLElement } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const view = new EditorView({ state: EditorState.create({ doc: "", extensions: [slashPalette({ uploadImage, container })] }), parent: document.body });
  const input = container.querySelector<HTMLInputElement>('[data-testid="lp-image-input"]');
  if (!input) throw new Error("picker did not inject its file input");
  return { view, input, container };
}

// jsdom/happy-dom's FileList cannot be constructed directly; the handler only ever reads
// `input.files?.[0]`, so an array-like stand-in is enough to drive it the same way a real pick does.
function pick(input: HTMLInputElement, f: File): void {
  Object.defineProperty(input, "files", { value: [f], configurable: true });
  input.dispatchEvent(new Event("change"));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("#934 the image picker reports upload failures — same chokepoint as #913's drag/paste", () => {
  it("success: no toast, and the reference is inserted (unchanged from before this fix)", async () => {
    const upload: ImageUploader = async () => ({ ref: "wks-attachment:abc", alt: "shot.png" });
    const { view, input, container } = mountWithPicker(upload);
    pick(input, file());
    await Promise.resolve(); // let uploadFiles' async body run
    await Promise.resolve();
    expect(view.state.doc.toString()).toContain("wks-attachment:abc");
    expect(notify.error).not.toHaveBeenCalled();
    view.destroy(); container.remove();
  });

  it("a 413 reports the SAME 'too large' toast #913 uses, and inserts no broken reference", async () => {
    const upload: ImageUploader = async () => { throw new ApiError(413, "/x/presign", "too big"); };
    const { view, input, container } = mountWithPicker(upload);
    pick(input, file());
    await Promise.resolve();
    await Promise.resolve();
    expect(view.state.doc.toString()).toBe("");
    expect(notify.error).toHaveBeenCalledWith("That file is too large to upload");
    view.destroy(); container.remove();
  });

  it("a generic failure (no status) reports the SAME generic toast #913 uses", async () => {
    const upload: ImageUploader = async () => { throw new TypeError("Failed to fetch"); };
    const { view, input, container } = mountWithPicker(upload);
    pick(input, file());
    await Promise.resolve();
    await Promise.resolve();
    expect(view.state.doc.toString()).toBe("");
    expect(notify.error).toHaveBeenCalledWith("Couldn't upload the file");
    view.destroy(); container.remove();
  });

  // Break-check: the pre-fix shape (`void upload(file).then(res => ...)`, no catch) leaves a REJECTED
  // promise with nothing awaited by the test and no listener attached — `notify.error` is never called
  // for either failure case above, so reverting `imageInsert` back to that form reddens both.
});
