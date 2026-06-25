import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { LanguageDescription } from "@codemirror/language";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { python } from "@codemirror/lang-python";
import { directiveExtension } from "./macros/directive-parser";

// Curated, SYNCHRONOUS language set for fenced-code syntax highlighting. Using
// `support` (not the async `load`) keeps highlighting instant — no flash of
// unhighlighted code — which fits the live-preview's realtime rendering (the
// reason we avoid async highlighters like Shiki). Unknown languages fall back to
// plain monospace. Add a language by adding one LanguageDescription here.
const codeLanguages = [
  LanguageDescription.of({
    name: "javascript",
    alias: ["js", "jsx", "ts", "tsx", "typescript"],
    support: javascript({ jsx: true, typescript: true }),
  }),
  LanguageDescription.of({ name: "json", support: json() }),
  LanguageDescription.of({ name: "python", alias: ["py"], support: python() }),
];

// Shared markdown language extension for BOTH editor surfaces:
//   - base markdownLanguage = GFM (tables, etc.)
//   - codeLanguages = per-language highlighting inside fenced code blocks
//   - directiveExtension = in-house ::: container directives (macros, ADR-022)
// Keeping it in one place means the source and live-preview parsers stay identical.
export const markdownExtension = () => markdown({ base: markdownLanguage, codeLanguages, extensions: [directiveExtension] });
