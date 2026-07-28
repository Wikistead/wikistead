// #450 / ADR-177 slice 5a: the macro SDK's foundation — one place that decides what a macro is handed.
//
// Until now a macro received exactly `{theme}` (ADR-024's narrow host-API) and the host-mediated
// resolutions (nested lists, transclusion, diagrams) reached it through MODULE SINGLETONS installed
// around the render (`withListHost` and, since slice 3, `withTranscludeHost` / `withDiagramHost`). That
// works while every macro is first-party, and it is the wrong shape for the third-party macros this
// ticket exists for: whatever is installed is visible to whoever renders next.
//
// The rules below are the user's rulings on this slice (#450R2), not invention:
//
//   1. FRESH PER DISPATCH, FROZEN. The SDK object is built at the dispatch seam for one render and
//      frozen. It is never a module singleton, so a macro that keeps a reference keeps an object whose
//      capability set was fixed when it was made — it cannot be read back later, "while nobody is
//      rendering", as a wider one.
//   2. effective(macro) = declared(macro) ∩ effective(caller). A nested macro can never hold more than
//      the macro that rendered it. A container therefore cannot be used as a ladder.
//   3. The host FORWARDS effective through its own re-entries (nested body renders, the callout panel,
//      the plain-content fallback) — see `withCallerCapabilities`.
//
// WHAT THIS IS NOT (ADR-177, stated because the opposite is easy to assume): in Stage 1 this is a
// DESIGN DISCIPLINE, not a security boundary. Macros run in the app's realm, so DOM a macro returns can
// reach `window` regardless of what its SDK says. The boundary is Stage 2 (ADR-075's cross-origin
// sandbox, macro-sandbox.ts); this keeps the surface honest and small until then, and gives the sandbox
// something exact to broker.
import { ALLOWED_CAPABILITIES } from "./macro-registry";
import type { MacroTheme } from "./registry";

export type MacroCapability = "theme" | "render-markdown" | "host-list" | "design-tokens";

// What a macro that declares nothing gets. Every first-party macro is in this position today (no macro
// carries a `capabilities` field yet), and it is exactly what they receive now — so introducing the SDK
// changes no macro's surface. A macro that DOES declare opts into the intersection rule with its list.
export const DEFAULT_DECLARED: readonly MacroCapability[] = ["theme"];

export function declaredCapabilities(macro: { capabilities?: readonly string[] }): ReadonlySet<string> {
  const raw = macro.capabilities;
  if (!raw) return new Set(DEFAULT_DECLARED);
  // Registration already refuses anything outside the vocabulary (registry.ts validateMacro), so this is
  // belt-and-braces for a macro object that reached a render without going through it.
  return new Set(raw.filter((c) => ALLOWED_CAPABILITIES.has(c)));
}

/** effective = declared ∩ caller. A `null` caller is the document root: nothing to intersect with. */
export function intersectCapabilities(
  declared: ReadonlySet<string>,
  caller: ReadonlySet<string> | null,
): ReadonlySet<string> {
  if (!caller) return new Set(declared);
  return new Set([...declared].filter((c) => caller.has(c)));
}

// The object a macro receives. `theme` is present only when the macro's effective set carries it, which
// is why it is optional here while `MacroContext.theme` is not: a macro that declares capabilities and
// leaves `theme` out has said it does not want it, and gets a context without it. That is visible
// immediately (its render reads undefined) rather than silently ignored.
export interface MacroSdk {
  readonly capabilities: readonly MacroCapability[];
  readonly theme?: MacroTheme;
}

export function createMacroSdk(args: {
  declared: ReadonlySet<string>;
  caller: ReadonlySet<string> | null;
  theme: MacroTheme;
}): MacroSdk {
  const effective = intersectCapabilities(args.declared, args.caller);
  const sdk: MacroSdk = {
    capabilities: Object.freeze([...effective].sort() as MacroCapability[]),
    ...(effective.has("theme") ? { theme: args.theme } : {}),
  };
  // Frozen, not merely readonly-typed: a macro is untrusted code in the same realm, and a type says
  // nothing at runtime. Freezing means one macro cannot widen the object a sibling render receives by
  // mutating a shared prototype-reachable field.
  return Object.freeze(sdk);
}

export const effectiveOf = (sdk: MacroSdk): ReadonlySet<string> => new Set(sdk.capabilities);

// The caller's effective set while the host re-enters its own renderer inside a macro's render (a
// container body, the callout panel, the plain-content fallback). It is HOST state — a macro can neither
// read nor write it — and it is saved/restored around each dispatch, which is sound because rendering is
// fully synchronous (the same justification the nesting-depth counter carries).
//
// This is a stepping stone, and worth naming as one: slice 5b hands containers `sdk.renderMarkdown`,
// which CLOSES OVER the caller's effective set, and then the forwarding is carried by the closure rather
// than by ambient state. The three host seams (`withListHost` / `withTranscludeHost` / `withDiagramHost`)
// retire the same way.
let callerCapabilities: ReadonlySet<string> | null = null;

export function withCallerCapabilities<T>(caller: ReadonlySet<string> | null, fn: () => T): T {
  const prev = callerCapabilities;
  callerCapabilities = caller;
  try { return fn(); } finally { callerCapabilities = prev; }
}

export const currentCallerCapabilities = (): ReadonlySet<string> | null => callerCapabilities;
