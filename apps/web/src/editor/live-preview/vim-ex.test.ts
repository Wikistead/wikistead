// @vitest-environment happy-dom
// #911 (user ruling, 2026-08-23): ":w saves and stays in the edit surface; :wq saves and leaves."
// Before this, :w and :wq were the SAME callback (`publish`), so a `:w` closed the editor exactly
// like `:wq` did. These drive the REAL vim engine's ex-command dispatcher (Vim.handleEx) against a
// real EditorView carrying vimExCommands — the thing that actually parses `:w` / `:wq` at a keypress,
// not a hand-rolled string-matcher standing in for it.
import { describe, it, expect, vi, afterEach } from "vitest";
import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { vim, Vim, getCM } from "@replit/codemirror-vim";
import { vimExCommands, type ExActions } from "./vim-ex";

let view: EditorView;

function mount(actions: ExActions) {
  view = new EditorView({
    state: EditorState.create({ doc: "hello", extensions: [vim(), vimExCommands(actions)] }),
    parent: document.body,
  });
  view.focus();
}

afterEach(() => {
  view?.destroy();
  document.body.innerHTML = "";
});

// getCM's declared return type is looser (state.vim may be null/undefined) than Vim.handleEx's
// CodeMirrorV param — real after mount()+focus(), just not narrowed by the library's own types.
const ex = (input: string) => Vim.handleEx(getCM(view) as Parameters<typeof Vim.handleEx>[0], input);

describe("#911 vim ex commands — :w stays, :wq leaves", () => {
  it(":w calls publishStay, and NOT publish", () => {
    const publish = vi.fn();
    const publishStay = vi.fn();
    mount({ publish, publishStay });
    ex("w");
    expect(publishStay).toHaveBeenCalledTimes(1);
    expect(publish).not.toHaveBeenCalled();
  });

  it(":wq calls publish, and NOT publishStay", () => {
    const publish = vi.fn();
    const publishStay = vi.fn();
    mount({ publish, publishStay });
    ex("wq");
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publishStay).not.toHaveBeenCalled();
  });

  it(":q calls exitEdit, and touches neither publish callback", () => {
    const publish = vi.fn();
    const publishStay = vi.fn();
    const exitEdit = vi.fn();
    mount({ publish, publishStay, exitEdit });
    ex("q");
    expect(exitEdit).toHaveBeenCalledTimes(1);
    expect(publish).not.toHaveBeenCalled();
    expect(publishStay).not.toHaveBeenCalled();
  });

  it(":w is a no-op (never throws) when the host supplies no publishStay callback", () => {
    mount({ publish: vi.fn() });
    expect(() => ex("w")).not.toThrow();
  });
});
