import { parseFenceInfo, serializeFenceInfo } from "@wikistead/macro-render";
import { asMacroSource, type MacroSettings, type MacroSource } from "./registry";

// #456 S4: a code fence's settings, declared rather than drawn. The controls say what a reader can
// configure — language, file name, line numbers, highlighted lines — and the two functions read and
// write the fence's own info string. The host renders the controls (macro-settings-controls.ts), so
// this file contains no DOM and no editor access at all.
//
// The notation is not ours: ADR-094 / #198 already parses and serialises the industry-standard info
// string (```ts title="app.ts" showLineNumbers {1,3-5}), and unknown attributes round-trip verbatim
// through `extra`. Configuring by mouse therefore cannot invent a private format or lose someone
// else's attribute — a settings write is the same string a hand-editor would have typed.

const LANGS = ["", "ts", "tsx", "js", "jsx", "json", "python", "go", "rust", "java", "sql", "bash", "yaml", "toml", "html", "css", "md"];

// "1,3-5" ⇄ [[1,1],[3,5]]. Anything unparsable is dropped rather than guessed at, which keeps a typo
// from silently highlighting the wrong lines.
function parseRanges(text: string): [number, number][] {
  const out: [number, number][] = [];
  for (const part of text.split(",")) {
    const m = /^\s*(\d+)\s*(?:-\s*(\d+)\s*)?$/.exec(part);
    if (!m) continue;
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    if (a > 0 && b >= a) out.push([a, b]);
  }
  return out;
}
function formatRanges(ranges: ReadonlyArray<readonly [number, number]> | undefined): string {
  return (ranges ?? []).map(([a, b]) => (a === b ? String(a) : `${a}-${b}`)).join(",");
}

// The source here is the fence's INFO STRING (what follows the backticks) — the smallest thing that
// round-trips, and the only part these settings touch. The body never passes through.
export const codeFenceSettings: MacroSettings = {
  controls: [
    { kind: "select", key: "lang", label: "Language", options: LANGS.map((v) => ({ value: v, label: v || "Plain text" })) },
    { kind: "text", key: "title", label: "File name", placeholder: "app.ts" },
    { kind: "toggle", key: "showLineNumbers", label: "Line numbers" },
    { kind: "lineRange", key: "highlight", label: "Highlight lines", placeholder: "1,3-5" },
  ],
  read(source) {
    const info = parseFenceInfo(source);
    return {
      lang: info.lang,
      title: info.title ?? "",
      showLineNumbers: info.showLineNumbers === true,
      highlight: formatRanges(info.highlight),
    };
  },
  write(source, values) {
    const info = parseFenceInfo(source); // start from the CURRENT info so `extra` survives
    info.lang = String(values.lang ?? "");
    const title = String(values.title ?? "").trim();
    info.title = title || undefined;
    info.showLineNumbers = values.showLineNumbers === true ? true : undefined;
    const ranges = parseRanges(String(values.highlight ?? ""));
    info.highlight = ranges.length ? ranges : undefined;
    return asMacroSource(serializeFenceInfo(info));
  },
};

// Convenience for a caller holding a whole opening line (```ts …) rather than just the info string.
export function fenceInfoOf(openingLine: string): MacroSource {
  const m = /^(\s*)([`~]{3,})(.*)$/.exec(openingLine);
  return asMacroSource(m?.[3] ?? "");
}
export function withFenceInfo(openingLine: string, info: MacroSource): string {
  const m = /^(\s*)([`~]{3,})(.*)$/.exec(openingLine);
  return m ? `${m[1]}${m[2]}${info}` : openingLine;
}
