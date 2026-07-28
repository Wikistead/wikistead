import { highlightTree } from "@lezer/highlight";
import { LanguageDescription } from "@codemirror/language";

// #505 (ruling 2) / ADR-194: colour a code fence on the READ surface — the reader, the print portal and
// the browser-built export — with the SAME highlighter the editor uses.
//
// The editor colours code because CodeMirror parses it and applies a HighlightStyle. Everything else
// rendering the same markdown showed plain black text, so a fence looked like two different things
// depending on which surface you were on, and printing it lost the colour entirely. Rather than a second
// palette (which is precisely the drift this line of work exists to end), this loads the editor's own
// language list and its own HighlightStyle and runs them over the fence body.
//
// Loading a language is asynchronous (each grammar is a dynamic import), and this sink is synchronous, so
// the fence renders as plain text first and is coloured when its grammar arrives — the same
// render-then-fill shape the macros use. The export waits for the surface to stop changing before it
// serializes, so the file gets the coloured version.

let cache: Promise<{ langs: LanguageDescription[]; style: { style(tags: readonly unknown[]): string | null } }> | null = null;

// One dynamic import for the editor's config, shared by every fence on the page.
function shared() {
  cache ??= Promise.all([import("../markdown-config"), import("../everforest-highlight")]).then(([md, hl]) => ({
    langs: md.codeLanguages,
    style: hl.everforestHighlightStyle as unknown as { style(tags: readonly unknown[]): string | null },
  }));
  return cache;
}

// Replace `codeEl`'s text with highlighted spans. Text-only in, elements out: every character comes from
// the original string via textContent, so nothing in a code block can become markup.
export function highlightInto(codeEl: HTMLElement, code: string, langName: string): void {
  if (!langName || !code.trim()) return;
  void shared().then(async ({ langs, style }) => {
    const desc = LanguageDescription.matchLanguageName(langs, langName, true);
    if (!desc) return; // unknown language → the plain text already rendered is the honest answer
    const support = desc.support ?? (await desc.load());
    // The element may have been re-rendered (or the surface torn down) while the grammar loaded.
    if (!codeEl.isConnected || codeEl.textContent !== code) return;
    const tree = support.language.parser.parse(code);
    const frag = document.createDocumentFragment();
    let pos = 0;
    const put = (from: number, to: number, cls: string | null) => {
      if (to <= from) return;
      const text = code.slice(from, to);
      if (!cls) { frag.appendChild(document.createTextNode(text)); return }
      const span = document.createElement("span");
      span.className = cls;
      span.textContent = text; // never innerHTML — a code block is user text
      frag.appendChild(span);
    };
    highlightTree(tree, style as never, (from, to, cls) => {
      put(pos, from, null);
      put(from, to, cls);
      pos = to;
    });
    put(pos, code.length, null);
    codeEl.replaceChildren(frag);
  }).catch(() => { /* a grammar that fails to load leaves the plain text — never a broken fence */ });
}
