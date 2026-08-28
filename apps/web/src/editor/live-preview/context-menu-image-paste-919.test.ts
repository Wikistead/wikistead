// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { contextMenu, pasteFromClipboard } from "./context-menu";
import type { ImageUploader } from "./commands";

function clipboardItem(entries: Record<string, Blob>): ClipboardItem {
  return {
    types: Object.keys(entries),
    getType: async (type: string) => entries[type]!,
    presentationStyle: "unspecified",
  } as ClipboardItem;
}

function setClipboard(items: ClipboardItem[], plain = ""): void {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { read: vi.fn().mockResolvedValue(items), readText: vi.fn().mockResolvedValue(plain) },
  });
}

function editor(uploadImage?: ImageUploader): EditorView {
  return new EditorView({
    parent: document.body.appendChild(document.createElement("div")),
    state: EditorState.create({ extensions: [contextMenu({ uploadImage })] }),
  });
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("#919 context-menu image paste", () => {
  it("uploads an image-only clipboard through the editor uploader", async () => {
    setClipboard([clipboardItem({ "image/png": new Blob(["png"], { type: "image/png" }) })]);
    const upload = vi.fn<ImageUploader>().mockResolvedValue({ ref: "wks-attachment:a1", alt: "shot" });
    const view = editor(upload);

    await pasteFromClipboard(view);

    expect(upload).toHaveBeenCalledOnce();
    const file = upload.mock.calls[0]![0];
    expect(file).toBeInstanceOf(File);
    expect(file.type).toBe("image/png");
    expect(view.state.doc.toString()).toBe("![shot](wks-attachment:a1)");
    view.destroy();
  });

  it("keeps multiple images in clipboard order and does not also insert accompanying text", async () => {
    setClipboard([
      clipboardItem({ "image/png": new Blob(["one"], { type: "image/png" }), "text/plain": new Blob(["ignored"], { type: "text/plain" }) }),
      clipboardItem({ "image/jpeg": new Blob(["two"], { type: "image/jpeg" }) }),
    ]);
    const upload = vi.fn<ImageUploader>()
      .mockResolvedValueOnce({ ref: "wks-attachment:1", alt: "one" })
      .mockResolvedValueOnce({ ref: "wks-attachment:2", alt: "two" });
    const view = editor(upload);

    await pasteFromClipboard(view);

    expect(upload.mock.calls.map(([file]) => file.type)).toEqual(["image/png", "image/jpeg"]);
    expect(view.state.doc.toString()).toBe("![one](wks-attachment:1)\n![two](wks-attachment:2)");
    view.destroy();
  });

  it("keeps text-only paste unchanged", async () => {
    setClipboard([clipboardItem({ "text/plain": new Blob(["plain text"], { type: "text/plain" }) })]);
    const view = editor(vi.fn<ImageUploader>());

    await pasteFromClipboard(view);

    expect(view.state.doc.toString()).toBe("plain text");
    view.destroy();
  });

  it("does nothing for an image when the surface has no uploader", async () => {
    setClipboard([clipboardItem({ "image/png": new Blob(["png"], { type: "image/png" }) })]);
    const view = editor();

    await pasteFromClipboard(view);

    expect(view.state.doc.length).toBe(0);
    view.destroy();
  });

  // design-review round-2 findings: a ClipboardItem's types are ALTERNATE representations of
  // the same data, not independent images — Ctrl+V's clipboardData.files gives one File per item.
  it("uploads once per ClipboardItem even when it exposes the same image under multiple types", async () => {
    setClipboard([clipboardItem({
      "image/png": new Blob(["png"], { type: "image/png" }),
      "image/svg+xml": new Blob(["svg"], { type: "image/svg+xml" }),
      "text/html": new Blob(["<img>"], { type: "text/html" }),
    })]);
    const upload = vi.fn<ImageUploader>().mockResolvedValue({ ref: "wks-attachment:a1", alt: "shot" });
    const view = editor(upload);

    await pasteFromClipboard(view);

    expect(upload).toHaveBeenCalledOnce();
    expect(view.state.doc.toString()).toBe("![shot](wks-attachment:a1)");
    view.destroy();
  });

  // A nested surface (table cell, callout body) never gets an uploader (editor-livepreview.ts always
  // passes uploadImage: undefined there) — Ctrl+V never attaches attachFileDrop on that surface either,
  // so text pasted alongside an image must still land, not be dropped by the image branch's early return.
  it("falls through to inserting the accompanying text when the surface has no uploader", async () => {
    setClipboard([clipboardItem({
      "image/png": new Blob(["png"], { type: "image/png" }),
      "text/plain": new Blob(["important text"], { type: "text/plain" }),
    })]);
    const view = editor();

    await pasteFromClipboard(view);

    expect(view.state.doc.toString()).toBe("important text");
    view.destroy();
  });
});
