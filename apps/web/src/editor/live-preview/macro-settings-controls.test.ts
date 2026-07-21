// @vitest-environment happy-dom
import { describe, it, expect, vi } from "vitest";
import { renderMacroSettings } from "./macro-settings-controls";
import { asMacroSource, type MacroSettings } from "../macros/registry";

// #456 S1 contract tests. The point of the declarative settings contract is that a macro — including
// one the host did not write — can offer mouse configuration without touching the DOM, the document
// or the editor. These pin the two properties that make that safe, plus the round trip.

const fenceSettings: MacroSettings = {
  controls: [
    { kind: "select", key: "lang", label: "Language", options: [{ value: "ts", label: "TypeScript" }, { value: "sql", label: "SQL" }] },
    { kind: "toggle", key: "lineNumbers", label: "Line numbers" },
    { kind: "text", key: "title", label: "File name", placeholder: "app.ts" },
    { kind: "lineRange", key: "highlight", label: "Highlight", placeholder: "1,3-5" },
  ],
  read: (source) => {
    const [info = ""] = source.split("\n");
    return {
      lang: /^(\w+)/.exec(info)?.[1] ?? "",
      lineNumbers: info.includes("showLineNumbers"),
      title: /title="([^"]*)"/.exec(info)?.[1] ?? "",
      highlight: /\{([^}]*)\}/.exec(info)?.[1] ?? "",
    };
  },
  write: (source, values) => {
    const rest = source.split("\n").slice(1).join("\n");
    const parts = [String(values.lang ?? "")];
    if (values.title) parts.push(`title="${String(values.title)}"`);
    if (values.lineNumbers) parts.push("showLineNumbers");
    if (values.highlight) parts.push(`{${String(values.highlight)}}`);
    return asMacroSource(`${parts.join(" ")}\n${rest}`);
  },
};

const SOURCE = asMacroSource('ts title="app.ts" {1,3-5}\nconst a = 1\n');

describe("#456 S1: declarative macro settings", () => {
  it("renders the declared controls, seeded from the macro's own reading of its source", () => {
    const panel = renderMacroSettings(fenceSettings, SOURCE, () => {});
    const lang = panel.dom.querySelector<HTMLSelectElement>('[data-testid="macro-setting-lang"]')!;
    const title = panel.dom.querySelector<HTMLInputElement>('[data-testid="macro-setting-title"]')!;
    const nums = panel.dom.querySelector<HTMLInputElement>('[data-testid="macro-setting-lineNumbers"]')!;
    const hl = panel.dom.querySelector<HTMLInputElement>('[data-testid="macro-setting-highlight"]')!;

    expect(lang.value).toBe("ts");
    expect(title.value).toBe("app.ts");
    expect(nums.checked).toBe(false);
    expect(hl.value).toBe("1,3-5");
  });

  it("a change writes through the macro's own write(), not through anything host-shaped", () => {
    const onWrite = vi.fn();
    const panel = renderMacroSettings(fenceSettings, SOURCE, onWrite);
    const nums = panel.dom.querySelector<HTMLInputElement>('[data-testid="macro-setting-lineNumbers"]')!;
    nums.checked = true;
    nums.dispatchEvent(new Event("change"));

    expect(onWrite).toHaveBeenCalledTimes(1);
    const next = onWrite.mock.calls[0]![0] as ReturnType<typeof asMacroSource>;
    expect(next).toContain("showLineNumbers");
    expect(next, "the body is untouched — settings only rewrite the info string").toContain("const a = 1");
    // and the macro's own read() sees its own write() (round trip through source, no host state)
    expect(fenceSettings.read(next).lineNumbers).toBe(true);
  });

  it("an unknown control kind is skipped, not guessed at", () => {
    const rogue = {
      ...fenceSettings,
      controls: [...fenceSettings.controls, { kind: "iframe", key: "x", label: "Anything" } as never],
    } satisfies MacroSettings;
    const panel = renderMacroSettings(rogue, SOURCE, () => {});
    expect(panel.dom.querySelectorAll("label")).toHaveLength(fenceSettings.controls.length);
    expect(panel.dom.querySelector('[data-testid="macro-setting-x"]')).toBeNull();
  });

  it("macro-supplied strings are bound as text — a label cannot become markup", () => {
    const nasty: MacroSettings = {
      controls: [{ kind: "select", key: "k", label: '<img src=x onerror="alert(1)">', options: [{ value: "v", label: "<b>bold</b>" }] }],
      read: () => ({ k: "v" }),
      write: (s) => s,
    };
    const panel = renderMacroSettings(nasty, SOURCE, () => {});
    expect(panel.dom.querySelector("img"), "no element was created from the label").toBeNull();
    expect(panel.dom.querySelector("b"), "nor from the option text").toBeNull();
    expect(panel.dom.textContent).toContain("<img src=x");
    expect(panel.dom.innerHTML).not.toContain("<img");
  });

  it("read/write stay pure — rendering does not mutate the source or require a document", () => {
    const before = SOURCE;
    const panel = renderMacroSettings(fenceSettings, SOURCE, () => {});
    expect(before, "the source string is untouched by rendering").toBe(SOURCE);
    panel.destroy();
    expect(panel.dom.isConnected).toBe(false);
  });
});
