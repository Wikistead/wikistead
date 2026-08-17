// @vitest-environment happy-dom
// ADR-105 / #225 anti-tests (condition B,/premises): the vim⇄clipboard seam must
// DELEGATE to vim's built-in paste for every non-clipboard case — a count (`3p`), a named register
// (`"ap`), a linewise register paste, mode 'off', visual mode, a denied/empty clipboard — and only
// the plain normal-mode `p`/`P` in 'paste' mode reads the OS clipboard (linkified, #223).
//
// The suite drives a REAL EditorView + the real vim engine with real capture-phase keydowns (the
// seam is a DOM listener — Vim.handleKey would bypass it and test nothing). The clipboard is a
// stub on navigator: happy-dom has no clipboard, which is also the perfect spy — every read is
// ours, and "readText was never called" is exactly the delegation claim.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { vim, Vim, getCM } from "@replit/codemirror-vim";
import { vimClipboardPaste, setVimClipboardMode, clipboardPastePayload } from "./vim-clipboard";

let view: EditorView;
let readText: ReturnType<typeof vi.fn>;

function mount(doc: string, opts?: { nested?: boolean }) {
  view = new EditorView({
    state: EditorState.create({ doc, extensions: [vim(), vimClipboardPaste(opts?.nested === true)] }),
    parent: document.body,
  });
  view.focus();
}

function key(k: string) {
  view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
}

// the clipboard read resolves on a microtask; give the replayed paste a beat to land
const settle = () => new Promise((r) => setTimeout(r, 1));

function setRegister(text: string, linewise: boolean) {
  Vim.getRegisterController().getRegister().setText(text, linewise);
}

beforeEach(() => {
  readText = vi.fn();
  Object.defineProperty(navigator, "clipboard", { value: { readText }, configurable: true });
  setVimClipboardMode("off");
});

afterEach(() => {
  view?.destroy();
  document.body.innerHTML = "";
  setVimClipboardMode("off");
  setRegister("", false); // the register controller is module-global — do not leak into the next test
});

describe("mode 'off' (the default): pure vim, the clipboard is never read", () => {
  it("p pastes ONLY the vim register; the OS clipboard is untouched and unread", async () => {
    readText.mockResolvedValue("OS-CONTENT");
    mount("ab\n");
    setRegister("REG", false);
    key("p");
    await settle();
    expect(view.state.doc.toString()).toBe("aREGb\n");
    expect(readText).not.toHaveBeenCalled();
  });
});

describe("mode 'paste': plain p/P read the system clipboard", () => {
  beforeEach(() => setVimClipboardMode("paste"));

  it("p pastes the clipboard text after the cursor (charwise, engine placement)", async () => {
    readText.mockResolvedValue("CLIP");
    mount("ab\n");
    key("p");
    await settle();
    expect(view.state.doc.toString()).toBe("aCLIPb\n");
  });

  it("P pastes the clipboard text before the cursor", async () => {
    readText.mockResolvedValue("CLIP");
    mount("ab\n");
    key("P");
    await settle();
    expect(view.state.doc.toString()).toBe("CLIPab\n");
  });

  it("a bare URL auto-linkifies exactly like Ctrl+V (#223 parity)", async () => {
    readText.mockResolvedValue("https://example.com/x");
    mount("\n");
    key("p");
    await settle();
    expect(view.state.doc.toString()).toContain("[https://example.com/x](https://example.com/x)");
  });

  it("a multi-line copy with a trailing newline pastes LINEWISE (below the current line)", async () => {
    readText.mockResolvedValue("one\ntwo\n");
    mount("top\nbottom\n");
    key("p");
    await settle();
    expect(view.state.doc.toString()).toBe("top\none\ntwo\nbottom\n");
  });

  it("y/d never write the OS clipboard (paste mode is read-only toward the OS)", async () => {
    const writeText = vi.fn();
    Object.defineProperty(navigator, "clipboard", { value: { readText, writeText }, configurable: true });
    mount("word here\n");
    key("y"); key("y"); // linewise yank
    key("d"); key("d"); // linewise delete
    await settle();
    expect(writeText).not.toHaveBeenCalled();
  });

  // ---- thecondition-B delegation contract ----

  it("3p (a count) delegates to the built-in paste: register content ×3, clipboard unread", async () => {
    readText.mockResolvedValue("OS");
    mount("x\n");
    setRegister("R", false);
    key("3"); key("p");
    await settle();
    expect(view.state.doc.toString()).toBe("xRRR\n");
    expect(readText).not.toHaveBeenCalled();
  });

  it('"ap (a named register) delegates: register a pastes, clipboard unread', async () => {
    readText.mockResolvedValue("OS");
    mount("x\n");
    Vim.getRegisterController().getRegister("a").setText("NAMED", false);
    key('"'); key("a"); key("p");
    await settle();
    expect(view.state.doc.toString()).toBe("xNAMED\n");
    expect(readText).not.toHaveBeenCalled();
  });

  it("linewise yank → p with an EMPTY clipboard falls back to the register, still linewise", async () => {
    // (No `j` motion here: happy-dom has no layout, and vim's j moves by VISUAL line, which
    // measures wrong without one — the paste lands where the register semantics say, which is
    // what this pin is about: a linewise register pastes BELOW the line, not at the caret.)
    readText.mockResolvedValue("");
    mount("aaa\nbbb\n");
    key("y"); key("y"); // yank the first line, linewise
    key("p");
    await settle();
    expect(view.state.doc.toString()).toBe("aaa\naaa\nbbb\n");
  });

  it("a denied clipboard read falls back to the vim register (no crash, no loss)", async () => {
    readText.mockRejectedValue(new DOMException("denied", "NotAllowedError"));
    mount("ab\n");
    setRegister("SAFE", false);
    key("p");
    await settle();
    expect(view.state.doc.toString()).toBe("aSAFEb\n");
  });

  it("visual-mode p delegates to the built-in (v1 scope: clipboard reads are normal-mode only)", async () => {
    readText.mockResolvedValue("OS");
    mount("abc\n");
    setRegister("R", false);
    key("v"); key("p");
    await settle();
    expect(readText).not.toHaveBeenCalled();
    expect(view.state.doc.toString()).toBe("Rbc\n"); // visual p replaced the selected 'a' from the register
  });

  it("insert mode types a literal p (the seam never fires outside normal mode)", async () => {
    readText.mockResolvedValue("OS");
    mount("\n");
    key("i");
    const cm = getCM(view)!;
    expect(cm.state.vim!.insertMode).toBe(true);
    key("p"); // the seam must not consume it; (happy-dom does not synthesize the actual text input)
    await settle();
    expect(readText).not.toHaveBeenCalled();
  });

  it("a read-only surface delegates (no clipboard read, no edit)", async () => {
    readText.mockResolvedValue("OS");
    view = new EditorView({
      state: EditorState.create({ doc: "ab\n", extensions: [vim(), vimClipboardPaste(false), EditorState.readOnly.of(true)] }),
      parent: document.body,
    });
    view.focus();
    key("p");
    await settle();
    expect(readText).not.toHaveBeenCalled();
    expect(view.state.doc.toString()).toBe("ab\n");
  });
});

describe("clipboardPastePayload (the island/linkify split,rec 4)", () => {
  it("body surface: a bare URL becomes a Markdown link", () => {
    expect(clipboardPastePayload("https://a.example/", false)).toBe("[https://a.example/](https://a.example/)");
  });
  it("nested island: the text passes through raw (Ctrl+V island-bypass parity)", () => {
    expect(clipboardPastePayload("https://a.example/", true)).toBe("https://a.example/");
  });
  it("non-URL text passes through unchanged on both surfaces", () => {
    expect(clipboardPastePayload("plain words", false)).toBe("plain words");
    expect(clipboardPastePayload("plain words", true)).toBe("plain words");
  });
});
