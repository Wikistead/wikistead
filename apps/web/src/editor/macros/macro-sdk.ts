// #450 / ADR-177 slice 5a: the macro SDK's foundation — one place that decides what a macro is handed.
//
// Until now a macro received exactly `{theme}` (ADR-024's narrow host-API) and the host-mediated
// resolutions (nested lists, transclusion, diagrams) reached it through MODULE SINGLETONS installed
// around the render (`withListHost` and, since slice 3, `withTranscludeHost` / `withDiagramHost`). That
// works while every macro is first-party, and it is the wrong shape for the third-party macros this
// ticket exists for: whatever is installed is visible to whoever renders next.
//
// The rules below are the user's rulings on this slice (#450 R2), not invention:
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

// What a macro that declares NOTHING gets — and imposes on what it nests.
//
// It is the whole brokered vocabulary, not `["theme"]`, and that was measured rather than chosen: with
// `["theme"]` the first-party containers (columns/tabs/callout/details, none of which declare) stopped
// handing their children `renderMarkdown`, so nested macros lost their `data-mac-pos` tags — the #215
// hit-test data — and `:::children` nested in a column fell back to a placeholder in six browser tests.
// Every first-party macro is in this position, and today they receive whatever the host installs; the SDK
// must not change that by existing.
//
// The trade, stated plainly: a macro that declares nothing is HOST CODE, and the ladder rule (R2) bites
// where it is aimed — at a macro that DECLARES, i.e. anything registered through the marketplace manifest
// (#310 refuses a submission without a vocabulary-valid capability list). A declared macro gets exactly
// its list intersected with its caller's, so it can neither hold more than it asked for nor more than the
// macro rendering it.
export const DEFAULT_DECLARED: readonly MacroCapability[] = ["theme", "render-markdown", "host-list", "design-tokens"];

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
  /**
   * Render markdown that belongs to THIS macro's body (#450 slice 5b, ruling R1).
   *
   * `relativeOffset` is an offset INSIDE the body the macro was handed — the only position a macro
   * legitimately knows. The host adds its own base, clamps to the body, and tags the nested macros; a
   * macro never sees or supplies an absolute document position. That matters because the tag flows to
   * `innermostMacroAt` and then to the delete range: an absolute anchor from a macro is an instruction
   * to delete a block of its choosing, and clamping cannot save it — a clamped-but-wrong anchor still
   * names a real, different block (which is why "macro passes, host clamps" was refused).
   *
   * Present only when the macro's effective set carries `render-markdown`.
   */
  readonly renderMarkdown?: (src: string, relativeOffset?: number) => DocumentFragment;
  /**
   * An OPAQUE identity for this rendered instance (#450 slice 5b). Containers keep display-only state
   * across re-renders (the tabs widget remembers which tab was open) and used to key it by the absolute
   * document offset they took out of the take-once singleton. The offset is exactly what ruling R1 says a
   * macro must not hold, so the host hands an opaque token instead: usable as a Map key, useless as a
   * position. Not capability-gated — it grants nothing.
   */
  readonly instanceKey?: string;
  /**
   * Ask the HOST for a slot it owns and fills (#450 slice 5c, ruling R3).
   *
   * The parameters are a fixed, host-defined schema of VALUES — never markup, never an element, and never
   * a condition the macro assembles. Anything outside the schema is refused here rather than interpreted,
   * because in Stage 2 this is the one channel out of the sandbox: widening later is easy, narrowing later
   * breaks whatever already shipped.
   *
   * The host owns the slot's whole lifecycle (placeholder, the view-filtered fetch, what an empty result
   * looks like on this surface, and telling the editor its height changed). The macro places the element
   * and nothing more — it cannot see the results, let alone fetch them (ADR-024: macros never fetch).
   */
  readonly hostSlot?: (params: HostSlotParams) => HTMLElement;
}

/** The only shapes a macro may ask for (#450 R3). Values only. */
export type HostSlotParams = {
  readonly kind: "list";
  readonly source: "tagged" | "children";
  readonly query?: string;
};

export function createMacroSdk(args: {
  declared: ReadonlySet<string>;
  caller: ReadonlySet<string> | null;
  theme: MacroTheme;
  /** The absolute doc offset of the body being rendered, or null when this render is not anchored. */
  baseOffset?: number | null;
  /** The body itself — the host clamps a macro's relative offset to it. */
  body?: string;
  /** How the host renders markdown; injected so this module stays free of the renderer. */
  render?: (src: string, absoluteOffset: number | undefined, caller: ReadonlySet<string>) => DocumentFragment;
  /** Opaque per-instance token (see MacroSdk.instanceKey). */
  instanceKey?: string;
  /** The host's slot factory, already bound to this surface (see MacroSdk.hostSlot). */
  hostSlot?: (params: HostSlotParams) => HTMLElement;
}): MacroSdk {
  const effective = intersectCapabilities(args.declared, args.caller);
  const renderMarkdown = effective.has("render-markdown") && args.render
    ? (src: string, relativeOffset?: number): DocumentFragment => {
        // The macro's number is an offset into its own body and nothing else. Clamping is defence in
        // depth (ruling R1: it is NOT the primary defence — the primary defence is that the macro cannot
        // express an absolute position at all).
        const body = args.body ?? "";
        const rel = typeof relativeOffset === "number" && Number.isFinite(relativeOffset)
          ? Math.max(0, Math.min(Math.trunc(relativeOffset), body.length))
          : null;
        const base = args.baseOffset ?? null;
        const absolute = base != null && rel != null ? base + rel : undefined;
        // The effective set travels WITH the call, so a nested macro intersects with this macro rather
        // than with whatever ambient state happens to be installed.
        return args.render!(src, absolute, effective);
      }
    : undefined;
  const sdk: MacroSdk = {
    capabilities: Object.freeze([...effective].sort() as MacroCapability[]),
    ...(effective.has("theme") ? { theme: args.theme } : {}),
    ...(renderMarkdown ? { renderMarkdown } : {}),
    ...(args.instanceKey ? { instanceKey: args.instanceKey } : {}),
    // Capability-gated: a macro that did not declare `host-list` is handed no slot factory at all, so
    // "may I?" is answered by the object's shape rather than by a check the macro could skip.
    ...(effective.has("host-list") && args.hostSlot ? { hostSlot: args.hostSlot } : {}),
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
