import { asMacroSource, type DirectiveMacro, type EditUI } from "./registry";
import { parseDirectiveOpen } from "./directive-parser";
// #85 slice 2: the callout type list + export htmlRender are the single source of truth in
// @wikistead/macro-render (shared with the server export). This file adds the editor icon + metadata.
import { CALLOUT_TYPES, calloutHtmlRender, type CalloutType } from "@wikistead/macro-render";
import i18n from "../../i18n"; // #174 comment 883: panel strings are localized (en/ja), not hardcoded
import { calloutTypeOption } from "./callout-type-ui";

// #174 / ADR-087: the shared callout editUI (type / label / body), reached via the single edit button.
// sourceScope "block" — the editor owns the WHOLE `:::type[label]…:::` so it can change the TYPE (the
// directive NAME) and the `[label]`, which a body-only scope can't reach. save reconstructs the block.
const calloutEditUI: EditUI = {
  present: "inline",
  sourceScope: "block",
  mount(container, source, _ctx, save, editEnv) {
    const lines = source.split("\n");
    const open = parseDirectiveOpen(lines[0] ?? "");
    let type = open?.name ?? "note";
    let label = open?.label ?? "";
    let body = lines.slice(1, Math.max(1, lines.length - 1)).join("\n");
    const commit = () => save(asMacroSource(`:::${type}${label ? `[${label}]` : ""}\n${body}\n:::`));

    // #174 comment 878 point 1 + 883: a titled panel with a VISIBLE, LOCALIZED label above every field
    // (Type / Header / Content) so it does not read as a bare HTML form. Each control sits in a
    // `.cm-lp-callout-edit-field` group (label + control), styled with the design-system tokens.
    const wrap = document.createElement("div");
    wrap.className = "cm-lp-callout-edit";
    const title = document.createElement("div");
    title.className = "cm-lp-callout-edit-title";
    title.textContent = i18n.t("calloutEdit.title");
    const field = (labelText: string): HTMLLabelElement => {
      const f = document.createElement("label");
      f.className = "cm-lp-callout-edit-field";
      const cap = document.createElement("span");
      cap.className = "cm-lp-callout-edit-cap";
      cap.textContent = labelText;
      f.appendChild(cap);
      return f;
    };

    // #174 comment 883: the Type field is a row of VISUAL chips — each type's icon + variant colour +
    // localized name (the shared calloutTypeOption, also used by the icon-badge picker) — instead of a
    // bare <select>, so the choices read at a glance. aria-pressed marks the current type.
    const typeField = field(i18n.t("calloutEdit.type"));
    const typeGroup = document.createElement("div");
    typeGroup.className = "cm-lp-callout-edit-types";
    typeGroup.setAttribute("role", "group");
    typeGroup.setAttribute("aria-label", i18n.t("calloutEdit.type"));
    typeGroup.setAttribute("data-testid", "callout-edit-type");
    const renderTypes = () => {
      typeGroup.textContent = "";
      for (const ty of CALLOUT_TYPES) {
        const b = calloutTypeOption(ty, ty === type);
        b.setAttribute("data-testid", `callout-edit-type-${ty}`);
        // mousedown (not click) + preventDefault so the panel's focus/selection is not disturbed.
        b.addEventListener("mousedown", (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (type === ty) return;
          type = ty;
          commit();
          renderTypes(); // re-render so the pressed state moves to the new type
        });
        typeGroup.appendChild(b);
      }
    };
    renderTypes();
    typeField.appendChild(typeGroup);

    const labelField = field(i18n.t("calloutEdit.header"));
    const labelIn = document.createElement("input");
    labelIn.className = "cm-lp-callout-edit-label";
    labelIn.value = label;
    labelIn.placeholder = i18n.t("calloutEdit.headerPlaceholder");
    labelIn.setAttribute("aria-label", i18n.t("calloutEdit.header"));
    labelIn.setAttribute("data-testid", "callout-edit-label");
    labelIn.addEventListener("change", () => { label = labelIn.value.trim(); commit(); });
    labelField.appendChild(labelIn);
    const bodyField = field(i18n.t("calloutEdit.content"));
    // #456 S5: a callout body is Markdown, so it edits on the HOST's surface — the same one the page
    // and the slot islands use (vim, the slash palette, completion, nested rendering), rather than the
    // plain textarea each macro used to build for itself. The textarea remains for a host that lends
    // no surface, which is what the unit tests mount against.
    const surface = editEnv?.mountSurface?.({
      parent: bodyField,
      doc: asMacroSource(body),
      kind: "markdown",
      testid: "callout-edit-body",
      onCommit: (v) => { body = v; commit(); },
    });
    let bodyTa: HTMLTextAreaElement | null = null;
    if (!surface) {
      bodyTa = document.createElement("textarea");
      bodyTa.className = "cm-lp-callout-edit-body";
      bodyTa.value = body;
      bodyTa.spellcheck = false;
      bodyTa.placeholder = i18n.t("calloutEdit.contentPlaceholder");
      bodyTa.setAttribute("aria-label", i18n.t("calloutEdit.content"));
      bodyTa.setAttribute("data-testid", "callout-edit-body");
      bodyTa.addEventListener("change", () => { body = bodyTa!.value; commit(); });
      bodyField.appendChild(bodyTa);
    }
    wrap.append(title, typeField, labelField, bodyField);
    container.appendChild(wrap);
    const f = setTimeout(() => (surface ? surface.focus() : bodyTa?.focus()), 0);
    return {
      destroy() { clearTimeout(f); surface?.destroy(); wrap.remove(); },
      handlesEscape: () => surface?.inVimInsert() ?? false, // vim's insert→normal Escape stays in the panel
    };
  },
};

// Typed callouts (#150 / ADR-049). Obsidian/GitHub-style admonitions, replacing the single
// `:::callout`. Syntax A: each type is its own directive name (`:::note` / `:::info` / `:::tip`
// / `:::warning` / `:::danger`). Lookup is case-insensitive (the registry lowercases), so
// `:::WARNING` == `:::warning`. Combinable with a leading `[label]` header (#94). The content
// stays Markdown (nested, reveal-on-cursor); the `:::` fences hide. An UNKNOWN type
// (`:::foobar`) falls back to `note` (Obsidian-compatible) — see `noteCalloutMacro` + the
// directive renderer. Each type carries a Lucide icon NAME (#158-C4): the open-line header
// renders it as a mask-image SVG (currentColor-tinted, ISC, no new dep) — see decorations.ts.

interface CalloutSpec {
  type: CalloutType;
  icon: string; // Lucide icon NAME (#158-C4); the header renders it as a mask-image SVG
}

// #158-C4 mapping (owner): note=Pencil (distinct from info), info=Info, tip=Lightbulb,
// warning=TriangleAlert, danger=OctagonAlert. Names key the mask-image CSS in decorations.ts. The type
// list itself is shared (CALLOUT_TYPES) so the editor and the server export stay in lockstep.
const ICONS: Record<CalloutType, string> = {
  note: "pencil", info: "info", tip: "lightbulb", warning: "triangle-alert", danger: "octagon-alert",
};
const SPECS: readonly CalloutSpec[] = CALLOUT_TYPES.map((type) => ({ type, icon: ICONS[type] }));

function makeCallout(spec: CalloutSpec): DirectiveMacro {
  return {
    kind: "directive",
    name: spec.type,
    // base class (shared box) + per-type modifier (colour). The icon (if any) renders as the
    // header via the open line's data-icon (display-only).
    containerClass: `cm-lp-callout cm-lp-callout-${spec.type}`,
    icon: spec.icon,
    editUI: calloutEditUI, // #174 / ADR-087: type/label/body panel via the single edit button
    exportFidelity: "preserve", // ::: stays plain text → lossless round-trip
    slash: {
      labelKey: `palette.callout.${spec.type}`,
      keywords: `callout admonition ${spec.type}`,
      insert: `:::${spec.type}\n\n:::`,
      caret: spec.type.length + 4, // ":::" + type + "\n" → the blank body line
    },
    // M3 export wrapper — single source of truth in @wikistead/macro-render (#85), shared with the
    // server export renderer. Escaping keeps it XSS-safe.
    htmlRender: calloutHtmlRender(spec.type),
  };
}

export const calloutMacros: readonly DirectiveMacro[] = SPECS.map(makeCallout);

// Fallback for an unknown directive type (`:::foobar` → note), Obsidian-compatible. The
// directive renderer uses this when `findDirectiveMacro(name)` misses.
export const noteCalloutMacro: DirectiveMacro = calloutMacros[0]!;
