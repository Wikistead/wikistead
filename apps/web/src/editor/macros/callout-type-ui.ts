import i18n from "../../i18n";
import type { CalloutType } from "@wikistead/macro-render";

// #174 comment 883: ONE visual "callout type" option — a variant-tinted chip carrying the type's
// mask-image icon + its LOCALIZED name — shared by the editUI panel's Type field AND the icon-badge
// type picker, so the two pickers cannot drift. The chip rides the existing per-type CSS assets:
// `cm-lp-callout-<type>` supplies `--cb-color` / `--cb-icon` (callout-icons.css, global) plus the
// variant background tint, and the inner span reuses the panel-icon mask (sized down by
// `.cm-lp-callout-type-opt-icon`). Chip layout rules live in callout-icons.css (GLOBAL, not the CM
// baseTheme) because the badge picker menu is mounted on document.body — outside .cm-editor — where
// baseTheme styles never reach. Display-only DOM; the caller wires mousedown + testids.
export function calloutTypeOption(ty: CalloutType, selected: boolean): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = `cm-lp-callout-type-opt cm-lp-callout-${ty}${selected ? " cm-lp-callout-type-opt-on" : ""}`;
  b.setAttribute("aria-pressed", String(selected));
  const ic = document.createElement("span");
  ic.className = "cm-lp-callout-panel-icon cm-lp-callout-type-opt-icon";
  ic.setAttribute("aria-hidden", "true");
  b.appendChild(ic);
  const name = document.createElement("span");
  name.className = "cm-lp-callout-type-opt-name";
  name.textContent = i18n.t(`calloutEdit.types.${ty}`);
  b.appendChild(name);
  return b;
}
