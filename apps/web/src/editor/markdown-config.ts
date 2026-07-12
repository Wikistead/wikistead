import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { LanguageDescription, LanguageSupport, StreamLanguage, type StreamParser } from "@codemirror/language";
import { directiveExtension } from "./macros/directive-parser";
import { highlightExtension } from "@wikistead/macro-render"; // #334 / ADR-129: shared `==` → <mark> grammar

// Fenced-code syntax highlighting (#158-C2 / #171). Broad language coverage (GitHub/Notion/Confluence
// class) via DYNAMIC import: each language's lezer parser (@codemirror/lang-*) or legacy stream mode
// (@codemirror/legacy-modes, all MIT) loads ONLY when a fence of that language appears — so the initial
// bundle stays small (the earlier synchronous set was 3 languages to avoid bloat; dynamic load lifts
// that limit). A brief flash of unhighlighted code on first use of a language is accepted (the review
// decision). An UNKNOWN language falls back to plain monospace (never breaks). The Everforest
// HighlightStyle (everforest-highlight.ts) colors whatever the loaded parser tags — face vs color are
// orthogonal (#158-C1/C4).

// Official lezer language package (dynamic import → LanguageSupport).
const lang = (name: string, alias: string[], load: () => Promise<LanguageSupport>) =>
  LanguageDescription.of({ name, alias, load });

// Legacy stream-parser mode (@codemirror/legacy-modes) wrapped as a LanguageSupport.
const legacy = (name: string, alias: string[], path: string, exportName: string) =>
  LanguageDescription.of({
    name, alias,
    load: () => import(`@codemirror/legacy-modes/mode/${path}`).then(
      (m: Record<string, StreamParser<unknown>>) => new LanguageSupport(StreamLanguage.define(m[exportName]!)),
    ),
  });

const codeLanguages: LanguageDescription[] = [
  // lezer parsers (rich, incremental)
  lang("javascript", ["js", "jsx", "ts", "tsx", "typescript", "node"], () =>
    import("@codemirror/lang-javascript").then((m) => m.javascript({ jsx: true, typescript: true }))),
  lang("python", ["py"], () => import("@codemirror/lang-python").then((m) => m.python())),
  lang("json", ["json5", "jsonc"], () => import("@codemirror/lang-json").then((m) => m.json())),
  lang("cpp", ["c", "c++", "h", "hpp", "cc"], () => import("@codemirror/lang-cpp").then((m) => m.cpp())),
  lang("java", [], () => import("@codemirror/lang-java").then((m) => m.java())),
  lang("rust", ["rs"], () => import("@codemirror/lang-rust").then((m) => m.rust())),
  lang("go", ["golang"], () => import("@codemirror/lang-go").then((m) => m.go())),
  lang("php", [], () => import("@codemirror/lang-php").then((m) => m.php())),
  lang("sql", ["postgres", "postgresql", "mysql"], () => import("@codemirror/lang-sql").then((m) => m.sql())),
  lang("html", ["htm"], () => import("@codemirror/lang-html").then((m) => m.html())),
  lang("css", [], () => import("@codemirror/lang-css").then((m) => m.css())),
  lang("xml", ["svg"], () => import("@codemirror/lang-xml").then((m) => m.xml())),
  lang("yaml", ["yml"], () => import("@codemirror/lang-yaml").then((m) => m.yaml())),
  lang("vue", [], () => import("@codemirror/lang-vue").then((m) => m.vue())),
  // legacy stream modes (broad long tail)
  legacy("shell", ["bash", "sh", "zsh", "console"], "shell", "shell"),
  legacy("ruby", ["rb"], "ruby", "ruby"),
  legacy("lua", [], "lua", "lua"),
  legacy("r", [], "r", "r"),
  legacy("perl", ["pl"], "perl", "perl"),
  legacy("haskell", ["hs"], "haskell", "haskell"),
  legacy("toml", ["ini"], "toml", "toml"),
  legacy("dockerfile", ["docker"], "dockerfile", "dockerFile"),
  legacy("swift", [], "swift", "swift"),
  legacy("clojure", ["clj"], "clojure", "clojure"),
  legacy("csharp", ["cs", "c#"], "clike", "csharp"),
  legacy("kotlin", ["kt"], "clike", "kotlin"),
  legacy("scala", [], "clike", "scala"),
  legacy("objective-c", ["objc", "objectivec"], "clike", "objectiveC"),
  legacy("dart", [], "clike", "dart"),
];

// Shared markdown language extension for BOTH editor surfaces:
//   - base markdownLanguage = GFM (tables, etc.)
//   - codeLanguages = per-language highlighting inside fenced code blocks (dynamic import)
//   - directiveExtension = in-house ::: container directives (macros, ADR-022)
// Keeping it in one place means the source and live-preview parsers stay identical.
export const markdownExtension = () => markdown({ base: markdownLanguage, codeLanguages, extensions: [directiveExtension, highlightExtension] });
