import { Vim, getCM } from "@replit/codemirror-vim";
import type { Extension } from "@codemirror/state";
import { ViewPlugin } from "@codemirror/view";
import { linkifyPaste } from "./paste-linkify";

// ADR-105 / #225: vim `p`/`P` read the SYSTEM clipboard when the user's account setting says so
// ('paste' mode). Everything else about vim paste is deliberately NOT re-implemented here:
//
// - The intercept is a CAPTURE-phase keydown on contentDOM (the atomYank / #91 mechanism — vim
//   consumes keys before any CM keymap, so a keymap can't see `p`; capture wins deterministically).
//   ADR-105 §2 originally sketched Vim.mapCommand, but a mapped action cannot DELEGATE to the
//   built-in paste (the actions registry is not public, and re-entering via Vim.handleKey would
//   loop through the very mapping that called it), so the capture intercept — where delegation is
//   simply "return without consuming" — is the mechanism that satisfiescondition B.
// - DELEGATION CONTRACT (condition B): every non-clipboard case falls through to vim's own
//   paste by RETURNING — a count (`3p`), a named/explicit register (`"ap`, `"+p`), visual mode,
//   insert mode, operator-pending, vim off, mode 'off'. We never re-implement paste semantics.
// - Even the clipboard case ends in the built-in paste: the clipboard text (linkified, #223) is
//   written into vim's UNNAMED register and the swallowed key is replayed via Vim.handleKey — so
//   charwise/linewise placement, cursor rest and dot-repeat are all the engine's own. A trailing
//   newline marks the register linewise, matching vim's own `"+p` treatment of multi-line copies.
// - Registered per-view but GLOBAL in effect only for the view the event targets; keys born in a
//   NESTED editor (slot island / table cell) are ignored here — the island's own instance (mounted
//   with `nested: true`) handles them, WITHOUT linkify, mirroring Ctrl+V's island bypass
//   (paste-linkify's inNestedIsland;recommendation 4 — linkify is a body-surface transform).
// - The mode is a MODULE-LEVEL REF (ADR-105 §2), not a facet/Compartment: the vim Compartment is
//   never reconfigured for this feature, so the vim-toggle-keeps-collab invariant holds by
//   construction. The ref is set from the account setting when it loads (routes.tsx) and read at
//   keystroke time.
// - `y`/`d`/`x`/`c` are untouched: 'paste' mode never WRITES the OS clipboard. (The 'full'
//   unnamed⇄clipboard sync was ruled OUT on #225/— no stable engine seam. If it ever
//   returns, its clipboard WRITES must ride the #549 atomClipboard event path, not a new one.)

export type VimClipboardMode = "off" | "paste";

let vimClipboardMode: VimClipboardMode = "off"; // pure vim until the account setting says otherwise

export function setVimClipboardMode(mode: VimClipboardMode): void {
  vimClipboardMode = mode;
}

// The paste payload for a clipboard text: linkified on the body surface (bare URL → [url](url),
// exactly Ctrl+V's transform), raw inside a nested island (Ctrl+V's island bypass). Pure → tested.
export function clipboardPastePayload(text: string, nested: boolean): string {
  if (nested) return text;
  return linkifyPaste({ text, html: "", selectedText: "" }) ?? text;
}

export function vimClipboardPaste(nested: boolean): Extension {
  return ViewPlugin.define((view) => {
    const onKeydown = (e: KeyboardEvent) => {
      if (e.key !== "p" && e.key !== "P") return;
      if (e.ctrlKey || e.metaKey || e.altKey) return; // chords belong to keymaps/vim, not this seam
      if (vimClipboardMode !== "paste") return; // 'off' → vim built-in, completely untouched
      // Keys born in a nested editor inside this contentDOM belong to that editor's own instance.
      const src = e.target as HTMLElement | null;
      if (src && src !== view.contentDOM && src.closest(".cm-content") !== view.contentDOM) return;
      if (view.state.readOnly) return;
      const cm = getCM(view);
      const vim = cm?.state.vim;
      if (!vim || vim.insertMode || vim.visualMode) return; // insert types 'p'; visual-p delegates (v1)
      const is = vim.inputState;
      // 3p / "ap / "+p / operator-pending → the built-in paste, with vim's full semantics. A COUNT
      // sits in inputState.keyBuffer (not prefixRepeat) until the command key arrives — measured on
      // @replit/codemirror-vim 6.3.0: after `3`, prefixRepeat is [] and keyBuffer is ["3"]. Any
      // pending buffered keys mean this press is part of a larger sequence — never ours.
      if (is && (is.operator || is.registerName || (is.prefixRepeat && is.prefixRepeat.length) || (is.keyBuffer && is.keyBuffer.length))) return;
      const clip = typeof navigator === "undefined" ? undefined : navigator.clipboard;
      if (!clip?.readText) return; // no async clipboard API (insecure context) → built-in
      const key = e.key;
      // From here the key is OURS: vim must not run its register paste for the same press.
      e.preventDefault();
      e.stopImmediatePropagation();
      const replay = () => { try { Vim.handleKey(cm!, key, "mapping"); } catch { /* view torn down mid-read */ } };
      clip.readText().then(
        (text) => {
          if (!text) { replay(); return; } // empty clipboard → graceful fallback to the vim register
          const payload = clipboardPastePayload(text, nested);
          // Route through the unnamed register + the built-in paste (see the header): the engine
          // decides charwise/linewise, cursor rest and repeat — we only supply the text.
          try { Vim.getRegisterController().getRegister().setText(payload, payload.endsWith("\n")); } catch { /* register unavailable */ }
          replay();
        },
        () => { replay(); }, // permission denied / read failure → the vim register, no crash
      );
    };
    view.contentDOM.addEventListener("keydown", onKeydown, true); // capture: before vim's handler
    return { destroy() { view.contentDOM.removeEventListener("keydown", onKeydown, true); } };
  });
}
