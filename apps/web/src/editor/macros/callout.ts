import type { DirectiveMacro } from "./registry";
// #85 slice 2: the callout type list + export htmlRender are the single source of truth in
// @wikistead/macro-render (shared with the server export). This file adds the editor icon + metadata.
import { CALLOUT_TYPES, calloutHtmlRender, type CalloutType } from "@wikistead/macro-render";

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

// #158-C4 mapping (the owner): note=Pencil (distinct from info), info=Info, tip=Lightbulb,
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
