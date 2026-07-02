import type { DirectiveMacro } from "./registry";
import { html } from "./safe-html";

// Typed callouts (#150 / ADR-049). Obsidian/GitHub-style admonitions, replacing the single
// `:::callout`. Syntax A: each type is its own directive name (`:::note` / `:::info` / `:::tip`
// / `:::warning` / `:::danger`). Lookup is case-insensitive (the registry lowercases), so
// `:::WARNING` == `:::warning`. Combinable with a leading `[label]` header (#94). The content
// stays Markdown (nested, reveal-on-cursor); the `:::` fences hide. An UNKNOWN type
// (`:::foobar`) falls back to `note` (Obsidian-compatible) — see `noteCalloutMacro` + the
// directive renderer. Each type carries a Lucide icon NAME (#158-C4): the open-line header
// renders it as a mask-image SVG (currentColor-tinted, ISC, no new dep) — see decorations.ts.

interface CalloutSpec {
  type: "note" | "info" | "tip" | "warning" | "danger";
  icon: string; // Lucide icon NAME (#158-C4); the header renders it as a mask-image SVG
}

// #158-C4 mapping (the owner): note=Pencil (distinct from info), info=Info, tip=Lightbulb,
// warning=TriangleAlert, danger=OctagonAlert. Names key the mask-image CSS in decorations.ts.
const SPECS: readonly CalloutSpec[] = [
  { type: "note", icon: "pencil" },
  { type: "info", icon: "info" },
  { type: "tip", icon: "lightbulb" },
  { type: "warning", icon: "triangle-alert" },
  { type: "danger", icon: "octagon-alert" },
];

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
    // M3 wires HTML export server-side; this supplies the wrapper. Escaping keeps it XSS-safe.
    htmlRender: (body) => html`<div class="callout callout-${spec.type}">\n\n${body}\n\n</div>`,
  };
}

export const calloutMacros: readonly DirectiveMacro[] = SPECS.map(makeCallout);

// Fallback for an unknown directive type (`:::foobar` → note), Obsidian-compatible. The
// directive renderer uses this when `findDirectiveMacro(name)` misses.
export const noteCalloutMacro: DirectiveMacro = calloutMacros[0]!;
