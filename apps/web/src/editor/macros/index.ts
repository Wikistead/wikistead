// Macro registry assembly. Importing this module registers the first-party macros
// (M1/M2 load nothing else — no foreign code, ADR-023 Stage 1). The editor imports
// `macroFold` from here, so registration runs before any editor mounts.
import { registerMacro } from "./registry";
import { mermaidMacro } from "./mermaid";
import { calloutMacro } from "./callout";

registerMacro(mermaidMacro);
registerMacro(calloutMacro);

export { macroFold } from "./fold";
export { findFenceMacro, findDirectiveMacro, registeredFenceLangs, registeredDirectiveNames } from "./registry";
export type { Macro, FenceMacro, DirectiveMacro, MacroContext, MacroTheme } from "./registry";
