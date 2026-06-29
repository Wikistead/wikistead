// Macro registry assembly. Importing this module registers the first-party macros
// (M1/M2 load nothing else — no foreign code, ADR-023 Stage 1). The editor imports
// `macroFold` from here, so registration runs before any editor mounts.
import { registerMacro } from "./registry";
import { mermaidMacro } from "./mermaid";
import { plantumlMacro } from "./plantuml";
import { calloutMacros } from "./callout";
import { excalidrawMacro } from "./excalidraw";
import { tableMacro } from "./table";
import { columnsMacro, tabsMacro, detailsMacro } from "./layout-directives";

registerMacro(mermaidMacro);
registerMacro(plantumlMacro); // ```plantuml — degrade-to-source until an external service is configured (#140 / ADR-074)
calloutMacros.forEach(registerMacro); // note / info / tip / warning / danger (#150)
registerMacro(excalidrawMacro);
registerMacro(tableMacro);
registerMacro(columnsMacro); // M2 layout directive (#90)
registerMacro(tabsMacro); // M2 layout directive (#90)
registerMacro(detailsMacro); // M2 layout directive (#90)

export { macroFold } from "./fold";
export { findFenceMacro, findDirectiveMacro, registeredFenceLangs, registeredDirectiveNames, registeredMacros } from "./registry";
export type { Macro, FenceMacro, DirectiveMacro, MacroContext, MacroTheme } from "./registry";
