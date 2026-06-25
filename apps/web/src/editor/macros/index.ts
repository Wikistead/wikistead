// Macro registry assembly. Importing this module registers the first-party macros
// (M1/M2 load nothing else — no foreign code, ADR-023 Stage 1). The editor imports
// `macroFold` from here, so registration runs before any editor mounts.
import { registerMacro } from "./registry";
import { mermaidMacro } from "./mermaid";
import { calloutMacro } from "./callout";
import { excalidrawMacro } from "./excalidraw";
import { tableMacro } from "./table";

registerMacro(mermaidMacro);
registerMacro(calloutMacro);
registerMacro(excalidrawMacro);
registerMacro(tableMacro);

export { macroFold } from "./fold";
export { findFenceMacro, findDirectiveMacro, registeredFenceLangs, registeredDirectiveNames, registeredMacros } from "./registry";
export type { Macro, FenceMacro, DirectiveMacro, MacroContext, MacroTheme } from "./registry";
