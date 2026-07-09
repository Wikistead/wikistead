import type { DirectiveMacro } from "./registry";
import { todoHtmlRender } from "@wikistead/macro-render";

// #290 / ADR-114: the `:::todo` directive — the PROMOTED form of a plain GFM task list. It renders as
// a tinted CONTAINER box (containerClass `cm-lp-callout cm-lp-todo`) whose body stays a real, CM-rendered GFM
// task list — so the ADR-019 **interactive** checkbox path applies UNCHANGED (no macro-specific checkbox
// logic). Deliberately NO `icon` field: an icon would make it render as a callout PANEL (renderCalloutPanel),
// whose body is display-only renderMarkdownToDom — that would break the interactive checkbox. The header icon
// still shows via the `.cm-lp-todo` `--cb-icon` on the open line's `cm-lp-directive-label`.
//
// The header PROGRESS RING (computed done/total) is a display-only open-line decoration — a follow-up slice
// (ADR-114 §6), kept out of the panel path precisely so the body checkboxes stay interactive.
//
// NO `slash` entry: `/todo` inserts the PLAIN task list (palette.ts); `:::todo` is reached by PROMOTING that
// block (the pipe-table ⇄ :::table seam, #216) — a later slice. exportFidelity=preserve (the `:::` round-trips
// losslessly; the ring is display-only and not exported).
export const todoMacro: DirectiveMacro = {
  kind: "directive",
  name: "todo",
  containerClass: "cm-lp-callout cm-lp-todo",
  exportFidelity: "preserve",
  htmlRender: todoHtmlRender,
};
