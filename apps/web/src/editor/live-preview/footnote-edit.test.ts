// @vitest-environment happy-dom
// #335 / ADR-130: the EDITOR live-preview surface for footnotes. A reference `[^label]` is styled as a
// superscript (delimiters hide reveal-on-cursor, like highlight's `==`); a definition line `[^label]: body`
// gets a muted line style and stays editable in place. The numbered end-of-document section is a rendered-
// surface concern (md-render / server export, covered by md-render.test.ts + server-render.test.ts) — the
// editor keeps definitions where they are authored. Headless CodeMirror; no browser needed.
import { describe, it, expect } from "vitest";
import { EditorState, EditorSelection } from "@codemirror/state";
import { markdownExtension } from "../markdown-config";
import { livePreview } from "./decorations";

// Build the live-preview decoration set with the caret parked FAR from the ref/def lines so nothing reveals.
function markClasses(doc: string): string[] {
  const state = EditorState.create({
    doc,
    selection: EditorSelection.cursor(0), // line 1; the assertions use refs/defs on later lines
    extensions: [markdownExtension(), livePreview],
  });
  const { decorations } = state.field(livePreview);
  const out: string[] = [];
  const cur = decorations.iter();
  while (cur.value) {
    const spec = cur.value.spec as { class?: string; attributes?: { class?: string } };
    const cls = spec.class ?? spec.attributes?.class;
    if (cls) out.push(cls);
    cur.next();
  }
  return out;
}

describe("footnote editor decorations (#335 / ADR-130)", () => {
  it("styles a reference `[^1]` as a superscript run", () => {
    // Ref on line 3 (caret is on line 1 → ref not revealed → the mark + hidden delimiters apply).
    const classes = markClasses("intro\n\ntext with a note[^1] here\n\n[^1]: the body\n");
    expect(classes).toContain("cm-lp-footnote-ref");
  });

  it("gives the definition line a muted line style", () => {
    const classes = markClasses("intro\n\ntext[^1]\n\n[^1]: the body\n");
    expect(classes).toContain("cm-lp-footnote-def");
  });

  it("does NOT footnote-style a real link or reference link", () => {
    const classes = markClasses("see [text](https://example.com) and [ref][id]\n\n[id]: https://x.example\n");
    expect(classes).not.toContain("cm-lp-footnote-ref");
    expect(classes).not.toContain("cm-lp-footnote-def");
  });

  it("does NOT treat an empty `[^]` as a footnote reference", () => {
    const classes = markClasses("text [^] here\n");
    expect(classes).not.toContain("cm-lp-footnote-ref");
  });
});
