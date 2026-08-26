// @vitest-environment happy-dom
// #913: `upload(file)` failing used to be swallowed silently by `.catch(() => null)` — a broken
// reference was correctly never inserted, but nothing told the author their paste/drop did
// anything. These drive the real `uploadFiles` against a real EditorView (doc content is the
// insertion signal) with a spy on `notify.error` (the reporting signal) and fake uploaders that
// throw the real error shapes (ApiError from apiFetch, a plain Error from the direct-to-storage
// PUT) or decline silently (return null, unchanged behaviour).
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { uploadFiles } from "./image-drop";
import { ApiError } from "../../data/apiClient";
import { notify } from "../../ui/toast";
import type { ImageUploader } from "./commands";

vi.mock("../../ui/toast", () => ({ notify: { success: vi.fn(), error: vi.fn() } }));

const file = (name = "shot.png", type = "image/png") => new File(["x"], name, { type });

function mountView(): EditorView {
  return new EditorView({ state: EditorState.create({ doc: "" }), parent: document.body });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("#913 uploadFiles — failure is reported, never silently swallowed", () => {
  it("succeeds silently: no toast, and the reference is inserted", async () => {
    const view = mountView();
    const upload: ImageUploader = async () => ({ ref: "wks-attachment:abc", alt: "shot.png" });
    await uploadFiles(view, upload, [file()]);
    expect(view.state.doc.toString()).toContain("wks-attachment:abc");
    expect(notify.error).not.toHaveBeenCalled();
    view.destroy();
  });

  it("a silent decline (null, no throw) stays quiet — the member 'page not resolved yet' guard", async () => {
    const view = mountView();
    const upload: ImageUploader = async () => null;
    await uploadFiles(view, upload, [file()]);
    expect(view.state.doc.toString()).toBe(""); // no broken reference inserted
    expect(notify.error).not.toHaveBeenCalled(); // and no toast — this was never an attempt
    view.destroy();
  });

  it("a 413 (ApiError, e.g. from presign) reports 'too large', and inserts nothing", async () => {
    const view = mountView();
    const upload: ImageUploader = async () => { throw new ApiError(413, "/x/presign", "too big"); };
    await uploadFiles(view, upload, [file()]);
    expect(view.state.doc.toString()).toBe("");
    expect(notify.error).toHaveBeenCalledWith("That file is too large to upload");
    view.destroy();
  });

  it("a 413 from the plain-Error PUT-step shape reports the SAME 'too large' toast", async () => {
    const view = mountView();
    const upload: ImageUploader = async () => { throw new Error("upload failed (413)"); };
    await uploadFiles(view, upload, [file()]);
    expect(notify.error).toHaveBeenCalledWith("That file is too large to upload");
    view.destroy();
  });

  it("a 415 (ApiError) reports 'unsupported type'", async () => {
    const view = mountView();
    const upload: ImageUploader = async () => { throw new ApiError(415, "/x/presign", "bad type"); };
    await uploadFiles(view, upload, [file("x.exe", "application/x-msdownload")]);
    expect(notify.error).toHaveBeenCalledWith("That file type can't be uploaded");
    view.destroy();
  });

  it("an unreachable-host / CORS failure (no status to read) reports the generic failure toast", async () => {
    const view = mountView();
    const upload: ImageUploader = async () => { throw new TypeError("Failed to fetch"); };
    await uploadFiles(view, upload, [file()]);
    expect(notify.error).toHaveBeenCalledWith("Couldn't upload the file");
    view.destroy();
  });

  it("mixed batch: successes are inserted, failures are reported by COUNT (not per-file detail)", async () => {
    const view = mountView();
    let n = 0;
    const upload: ImageUploader = async (f) => {
      n++;
      if (n === 2) throw new ApiError(413, "/x", "too big");
      if (n === 3) throw new Error("upload failed (500)");
      return { ref: `wks-attachment:${f.name}`, alt: f.name };
    };
    await uploadFiles(view, upload, [file("a.png"), file("b.png"), file("c.png"), file("d.png")]);
    const doc = view.state.doc.toString();
    expect(doc).toContain("wks-attachment:a.png");
    expect(doc).toContain("wks-attachment:d.png");
    expect(doc).not.toContain("b.png](wks-attachment"); // the two failures never got a reference
    expect(doc).not.toContain("c.png](wks-attachment");
    expect(notify.error).toHaveBeenCalledTimes(1);
    expect(notify.error).toHaveBeenCalledWith("2 files couldn't be uploaded"); // count, not two separate toasts
    view.destroy();
  });

  it("all files failing is still reported (not silently nothing)", async () => {
    const view = mountView();
    const upload: ImageUploader = async () => { throw new Error("network down"); };
    await uploadFiles(view, upload, [file("a.png"), file("b.png")]);
    expect(notify.error).toHaveBeenCalledWith("2 files couldn't be uploaded");
    view.destroy();
  });
});
