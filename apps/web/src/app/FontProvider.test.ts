// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { applyVimMono, refreshVimMono, vimMonoEnabled, RETIRED_FONT_KEY } from "./FontProvider";

// #633 / ADR-217, replacing the #190 body-font override this file used to cover.
//
// The old test asserted that each of four face NAMES wrote a distinct stack. That contract is retired:
// a name promises glyphs it cannot keep once a language arrives whose script the face lacks. What
// replaces it is one marker — is vim allowed to bring its column grid — and the question of WHICH
// surfaces that reaches now lives in CSS, so it is asked of the stylesheet here rather than of a
// TypeScript table that could drift from it.
describe("#633: vim's typography is a marker, not a face", () => {
  beforeEach(() => {
    document.documentElement.removeAttribute("data-vim-mono");
    try { localStorage.clear(); } catch { /* private mode */ }
  });

  it("marks the document when vim's grid applies, and unmarks it otherwise", () => {
    applyVimMono(true);
    expect(document.documentElement.hasAttribute("data-vim-mono")).toBe(true);
    applyVimMono(false);
    expect(document.documentElement.hasAttribute("data-vim-mono")).toBe(false);
  });

  it("writes no font-family of its own — the stylesheet decides what the marker means", () => {
    applyVimMono(true);
    // the old mechanism set an inline `--font-body`; which surfaces should change is a CSS question
    // (editor yes, print no), and a value written here would apply to all of them
    expect(document.documentElement.style.getPropertyValue("--font-body")).toBe("");
    expect(document.documentElement.style.fontFamily).toBe("");
  });

  it("needs all three of its inputs, and any one of them withdraws the grid", () => {
    // The three arrive from three owners — vim from the keymap (a server profile for a member, this
    // device for a guest), editing from the route, the toggle from storage — so the combination is
    // asserted rather than the calls. Reading a page with vim on is the case the ruling was about:
    // most of the time here is spent reading, and the font nobody can choose should not also be the
    // harder one to read.
    const root = document.documentElement;
    const set = (vim: boolean, editing: boolean, toggle: boolean) => {
      vim ? root.setAttribute("data-vim-on", "") : root.removeAttribute("data-vim-on");
      editing ? root.setAttribute("data-editing", "") : root.removeAttribute("data-editing");
      localStorage.setItem("wks.vimMono", toggle ? "1" : "0");
      refreshVimMono();
      return root.hasAttribute("data-vim-mono");
    };
    expect(set(true, true, true), "vim, editing, kept").toBe(true);
    expect(set(true, false, true), "vim on but only reading").toBe(false);
    expect(set(false, true, true), "editing without vim").toBe(false);
    expect(set(true, true, false), "vim and editing, but the reader turned it off").toBe(false);
    root.removeAttribute("data-vim-on");
    root.removeAttribute("data-editing");
  });

  it("defaults to ON for somebody who has never chosen (user ruling)", () => {
    expect(vimMonoEnabled(), "never touched").toBe(true);
    localStorage.setItem("wks.vimMono", "0");
    expect(vimMonoEnabled(), "turned off").toBe(false);
    localStorage.setItem("wks.vimMono", "1");
    expect(vimMonoEnabled(), "turned back on").toBe(true);
  });

  it("leaves the retired face choice in storage rather than deleting it", () => {
    // Not housekeeping: it is somebody's browser, the key is inert, and reaching in to erase a choice
    // nobody asked us to erase is the kind of quiet act this codebase keeps refusing elsewhere.
    localStorage.setItem(RETIRED_FONT_KEY, "sans");
    expect(vimMonoEnabled()).toBe(true);
    expect(localStorage.getItem(RETIRED_FONT_KEY), "still theirs").toBe("sans");
  });
});

describe("#633: the marker reaches the editor and stops at the door", () => {
  // Comments stripped: the rules below explain WHAT was retired by quoting it, and a search that reads
  // its own explanation as the thing it forbids condemns every correct stylesheet (the same trap #623's
  // OFFSET check fell into).
  const css = readFileSync(resolve(import.meta.dirname, "..", "styles", "tokens.css"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "");

  it("prose is proportional by default — the per-locale monospace body is gone", () => {
    expect(css, "the body token follows the same chain as the UI").toMatch(/--font-body:\s*var\(--font\)/);
    expect(css, "#190's `:root:lang(en) { --font-body: var(--font-code) }` is retired")
      .not.toMatch(/:root:lang\(en\)\s*\{[^}]*--font-body/);
  });

  it("code is monospace regardless — the vim rules never mention it", () => {
    expect(css).toMatch(/--font-code:\s*"Wikistead Mono"/);
    // a fence is monospace with vim off, in print, and in every language
    const marked = css.split("data-vim-mono").slice(1).join("");
    expect(marked, "the vim rules leave the code face alone").not.toMatch(/--font-code/);
  });

  it("reaches the editing surface and reading mode, and not the title", () => {
    const marked = css.split("data-vim-mono").slice(1).join("");
    expect(marked, "the editing surface").toMatch(/\.cm-content/);
    expect(marked, "…including prose inside it (macro and list bodies share the class)").toMatch(/\.wks-prose/);
    // Reading mode is a display mode OF that surface (a CodeMirror facet), so it is covered by the line
    // above rather than by a selector of its own — the first attempt matched a `[data-reading-mode]`
    // attribute this product does not have.
    expect(marked.match(/\.cm-content/g)?.length ?? 0, "and it is the surface, not one mode of it").toBeGreaterThan(1);
    // #190 made the page title follow the body face. That following stops here: a column grid aligns
    // things against each other, and a title has nothing to align against.
    expect(marked, "the page title does not follow").not.toMatch(/page-title|wks-title/);
  });

  it("is undone for print, because a printed page is not an editing surface", () => {
    const printBlock = css.slice(css.indexOf("@media print"));
    expect(printBlock, "print restores the proportional face")
      .toMatch(/data-vim-mono[\s\S]*--font-body:\s*var\(--font\)/);
  });
});
