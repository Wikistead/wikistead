import { MACRO_CONTROL_KINDS, type MacroControl, type MacroSettingValues, type MacroSettings, type MacroSource } from "../macros/registry";

// #456 S1: the HOST side of declarative macro settings. A macro declares controls and two pure
// functions over its own source (registry.ts, MacroSettings); this renders them and writes the
// result back through the macro's own `write`. The macro never sees the DOM, the document or the
// editor — which is what lets a third-party macro have a settings UI without widening the host-API
// (ADR-023's narrow boundary).
//
// Two rules make that safe rather than merely tidy:
//   1. Only the kinds the host knows how to render are rendered. An unknown kind is skipped, not
//      guessed at — a macro cannot smuggle in a control the host has no safe rendering for.
//   2. Every macro-supplied string (label, option text, placeholder) is bound as TEXT, never as
//      markup. There is no innerHTML on this path, so a label is a label even if it contains tags.

export interface MacroSettingsPanel {
  readonly dom: HTMLElement;
  destroy(): void;
}

const KNOWN = new Set<string>(MACRO_CONTROL_KINDS);

function labelled(text: string, control: HTMLElement): HTMLLabelElement {
  const label = document.createElement("label");
  label.className = "cm-lp-macro-setting";
  const span = document.createElement("span");
  span.className = "cm-lp-macro-setting-label";
  span.textContent = text; // text, never markup — see rule 2
  label.append(span, control);
  return label;
}

function buildControl(c: MacroControl, values: MacroSettingValues, onChange: (key: string, value: string | boolean) => void): HTMLElement | null {
  switch (c.kind) {
    case "select": {
      const el = document.createElement("select");
      el.dataset.testid = `macro-setting-${c.key}`;
      for (const o of c.options) {
        const opt = document.createElement("option");
        opt.value = o.value;
        opt.textContent = o.label;
        el.append(opt);
      }
      el.value = String(values[c.key] ?? "");
      el.addEventListener("change", () => onChange(c.key, el.value));
      return labelled(c.label, el);
    }
    case "toggle": {
      const el = document.createElement("input");
      el.type = "checkbox";
      el.dataset.testid = `macro-setting-${c.key}`;
      el.checked = values[c.key] === true;
      el.addEventListener("change", () => onChange(c.key, el.checked));
      return labelled(c.label, el);
    }
    case "text":
    case "lineRange": {
      const el = document.createElement("input");
      el.type = "text";
      el.dataset.testid = `macro-setting-${c.key}`;
      if (c.placeholder) el.placeholder = c.placeholder;
      el.value = String(values[c.key] ?? "");
      // commit on change (blur / Enter) rather than per keystroke: each write is one document edit
      el.addEventListener("change", () => onChange(c.key, el.value));
      return labelled(c.label, el);
    }
    default:
      return null; // unreachable for known kinds; the guard below covers unknown ones
  }
}

// Renders `settings.controls` for `source` and calls `onWrite` with the macro's own rewritten source
// whenever a control changes. `onWrite` is what the host turns into a single offset-invariant edit.
export function renderMacroSettings(
  settings: MacroSettings,
  source: MacroSource,
  onWrite: (next: MacroSource) => void,
): MacroSettingsPanel {
  const dom = document.createElement("div");
  dom.className = "cm-lp-macro-settings";
  dom.dataset.testid = "macro-settings";

  let values = settings.read(source);
  const onChange = (key: string, value: string | boolean) => {
    values = { ...values, [key]: value };
    onWrite(settings.write(source, values));
  };

  for (const c of settings.controls) {
    if (!KNOWN.has(c.kind)) continue; // rule 1
    const el = buildControl(c, values, onChange);
    if (el) dom.append(el);
  }

  return {
    dom,
    destroy() {
      dom.remove();
    },
  };
}
