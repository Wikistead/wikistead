import katex from "katex";
import { unsafeHtml, type SafeHtml } from "./safe-html.js";

// #505 / #207 / #85 (ADR-191): math on the STATIC render path.
//
// The editor renders `$…$` / `$$…$$` with KaTeX (live-preview/math.ts), but the canonical HTML this
// package produces — the one the export, the public page and (per ADR-191) the print sheet all come
// from — passed the TeX through as text. So a page that reads as mathematics on screen printed as raw
// `$x^2$`. The user's acceptance for the print work is explicit: "every rendered element is in scope;
// none of them may break in print", and math is the element that was out of scope.
//
// The delimiter rules below are a DELIBERATE MIRROR of the editor's findMath (live-preview/math.ts) —
// including the Pandoc-style inline guards that keep prose about money from turning into math. If the
// two disagree, the screen and the print disagree, which is the whole thing ADR-191 is closing. Kept as
// a pure string scanner (no CodeMirror state) so both sides can be pinned against the same cases.
export interface MathSpan { from: number; to: number; tex: string; display: boolean }

export function findMathSpans(text: string): MathSpan[] {
  const out: MathSpan[] = [];
  const taken: [number, number][] = [];
  const overlaps = (a: number, b: number) => taken.some(([x, y]) => a < y && b > x);
  const esc = (i: number) => i > 0 && text[i - 1] === "\\";

  // Block $$…$$ first, so an inline scan can't chop one in half.
  for (let i = 0; i < text.length - 1; i++) {
    if (text[i] === "$" && text[i + 1] === "$" && !esc(i)) {
      let j = i + 2;
      while (j < text.length - 1 && !(text[j] === "$" && text[j + 1] === "$" && !esc(j))) j++;
      if (j < text.length - 1 && text[j] === "$" && text[j + 1] === "$") {
        const from = i, to = j + 2, tex = text.slice(i + 2, j).trim();
        if (tex) { out.push({ from, to, tex, display: true }); taken.push([from, to]) }
        i = j + 1;
      }
    }
  }
  // Inline $…$ — the full Pandoc/CommonMark-math rule (#141): the opening `$` is followed by a
  // non-space, the closing `$` is preceded by a non-space, and the closing `$` is not run into a digit.
  // Together they reject "$5 and $6", "$5 and$6" and "$100$200" while keeping "$x^2$".
  const nonWs = (c: string | undefined) => !!c && !/\s/.test(c);
  const isDigit = (c: string | undefined) => !!c && c >= "0" && c <= "9";
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "$" && !esc(i) && text[i + 1] !== "$" && !overlaps(i, i + 1) && nonWs(text[i + 1])) {
      let j = i + 1;
      while (j < text.length && text[j] !== "$" && text[j] !== "\n") { if (text[j] === "\\") j++; j++ }
      if (j < text.length && text[j] === "$" && !esc(j) && nonWs(text[j - 1]) && !isDigit(text[j + 1])) {
        const from = i, to = j + 1, tex = text.slice(i + 1, j).trim();
        if (tex && !overlaps(from, to)) { out.push({ from, to, tex, display: false }); taken.push([from, to]) }
        i = j;
      }
    }
  }
  return out.sort((a, b) => a.from - b.from);
}

// Render one span with KaTeX. `output: "mathml"` is chosen for the STATIC document on purpose: a print
// sheet / export must be SELF-CONTAINED, and KaTeX's HTML output depends on its stylesheet AND its own
// woff2 fonts — absent them the symbols render as the wrong glyphs, which is precisely the "broken in
// print" the acceptance forbids. MathML needs neither: the browser draws it with its own math font, so
// the document stands alone with nothing to 404.
//
// XSS: KaTeX builds this markup itself from the TeX; `trust: false` disables \href/\includegraphics and
// friends, and `strict: "warn"` keeps unknown commands from throwing. This is the SAME configuration the
// editor uses, so the two paths trust KaTeX identically. On a hard failure we fall back to the escaped
// source — never a broken embed, and the TeX is still readable (Open formats).
export function renderMathHtml(tex: string, display: boolean): SafeHtml | null {
  try {
    const markup = katex.renderToString(tex, {
      displayMode: display,
      output: "mathml",
      throwOnError: false,
      trust: false,
      strict: "warn",
    });
    return unsafeHtml(markup); // KaTeX-generated, trust:false — the editor path makes the same call
  } catch {
    return null; // caller degrades to the escaped TeX
  }
}
