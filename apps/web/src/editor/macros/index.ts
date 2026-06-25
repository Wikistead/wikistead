// Macro registry assembly. Importing this module registers the first-party macros
// (M1/M2 load nothing else — no foreign code, ADR-023 Stage 1). The editor imports
// `macroFold` from here, so registration runs before any editor mounts.
import { registerMacro } from "./registry";
import { mermaidMacro } from "./mermaid";

registerMacro(mermaidMacro);

export { macroFold } from "./fold";
export { findFenceMacro, registeredFenceLangs } from "./registry";
export type { Macro, FenceMacro, MacroContext, MacroTheme } from "./registry";
