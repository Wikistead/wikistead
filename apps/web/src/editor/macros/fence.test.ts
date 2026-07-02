// @vitest-environment happy-dom
import { describe, it, expect, beforeAll } from "vitest";
import { EditorState } from "@codemirror/state";
import { markdownExtension } from "../markdown-config";
import { registerMacro } from "./registry";
import { directiveChainAt, directiveMacroAt } from "./fence";

// #196 / ADR-092: directiveChainAt returns the nesting chain of registered directive macros containing
// a position, OUTERMOST first → INNERMOST last (foundation for innermost-wins reveal). Verify: empty
// when outside any directive; a single-element chain whose last === directiveMacroAt; and, for a nested
// pair (outer colon-count > inner), the chain is [outer, inner].
const state = (doc: string) => EditorState.create({ doc, extensions: [markdownExtension()] });
const at = (doc: string, needle: string) => doc.indexOf(needle) + 1; // a pos inside `needle`

describe("directiveChainAt (#196 nesting chain)", () => {
  beforeAll(() => {
    // two registered macros so both nesting layers resolve (unregistered directives are skipped).
    registerMacro({ kind: "directive", name: "chout", exportFidelity: "preserve", containerClass: "cm-lp-chout", icon: "info", htmlRender: (b) => b });
    registerMacro({ kind: "directive", name: "chin", exportFidelity: "preserve", containerClass: "cm-lp-chin", icon: "info", htmlRender: (b) => b });
  });

  it("returns [] when the caret is in no directive", () => {
    const s = state("just a paragraph\n");
    expect(directiveChainAt(s, at("just a paragraph\n", "paragraph"))).toEqual([]);
  });

  it("returns a single-element chain for one directive; its last element === directiveMacroAt", () => {
    const doc = ":::chin\nhello body\n:::\n";
    const s = state(doc);
    const pos = at(doc, "hello");
    const chain = directiveChainAt(s, pos);
    expect(chain.map((d) => d.name)).toEqual(["chin"]);
    expect(chain[chain.length - 1]!.name).toBe(directiveMacroAt(s, pos)!.name); // innermost consistency
  });

  it("returns [outer, inner] for a nested pair (outermost first)", () => {
    // outer uses MORE colons than inner so the directive parser nests them (colons: 5 > 3).
    const doc = ":::::chout\n:::chin\ndeep body\n:::\n:::::\n";
    const s = state(doc);
    const chain = directiveChainAt(s, at(doc, "deep body"));
    expect(chain.map((d) => d.name)).toEqual(["chout", "chin"]); // outermost → innermost
    // a caret in the OUTER (between the outer open and the inner open) yields only [chout]
    const outerOnly = directiveChainAt(s, at(doc, ":::::chout") + 3);
    expect(outerOnly.map((d) => d.name)).toEqual(["chout"]);
  });
});
