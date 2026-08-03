import i18n from "../../i18n";
import { findDirectiveMacro, findFenceMacro, type Macro } from "./registry";

// #600: when a macro cannot show its content, the thing on screen must say WHICH macro it is. Four of
// these states used to render `…`, an empty node, or a hardcoded English sentence, so a reader met a
// block that told them nothing — not even what kind of block it was. The name is safe to give: it is
// written in the reader's own source, a few characters away.
//
// One template, one place. Before this, four different sentence shapes shared the same slot ("Empty
// drawing: Ctrl+↵ to open", "Invalid PlantUML diagram", "Could not reach the diagram renderer",
// "Cannot display this content") because every macro built its own string. A macro passes a STATE and
// gets the sentence; it never writes one.

export type MacroPlaceholderState =
  /** Nothing authored yet, and the next step is to edit / open / add. */
  | "empty-edit" | "empty-open" | "empty-url" | "empty-page"
  /** Authored, and the content is on its way. */
  | "loading"
  /** Authored, but this surface has no way to resolve it (no host installed here). */
  | "no-host"
  /** Authored, and the reader may not see it. Deliberately says nothing about WHY (see below). */
  | "hidden"
  /** The source does not parse. */
  | "invalid"
  /** The renderer could not be reached. */
  | "unreachable";

const DETAIL: Record<MacroPlaceholderState, string> = {
  "empty-edit": "macro.nextEdit",
  "empty-open": "macro.nextOpen",
  "empty-url": "macro.nextAddUrl",
  "empty-page": "macro.nextAddPage",
  loading: "macro.stateLoading",
  "no-host": "macro.stateNoHost",
  hidden: "macro.stateHidden",
  invalid: "macro.stateInvalid",
  unreachable: "macro.stateUnreachable",
};
const IS_EMPTY = (s: MacroPlaceholderState) => s.startsWith("empty-");

/** The macro's name as the product already shows it. Never invents one. */
export function macroDisplayName(macro: Macro): string {
  // `nameKey` exists for the macros whose palette entry is phrased as an action ("Embed a page"), which
  // does not read as a name in a sentence. Everything else reuses the palette label the author picked
  // the macro by — the same words, in the same language.
  const key = macro.nameKey ?? macro.slash?.labelKey;
  return key ? i18n.t(key) : macro.kind === "fence" ? macro.lang : macro.name;
}

function lookup(id: string): Macro | undefined {
  return findFenceMacro(id) ?? findDirectiveMacro(id);
}

/**
 * The sentence a macro shows in place of its content. `macro` may be the registry entry or its
 * fence lang / directive name.
 *
 * `hidden` is the existence-hiding state (ADR-071): denied, cyclic and absent references all reach it
 * and all read identically. Naming the MACRO is safe — the reader wrote `:::embed-page` themselves —
 * but the state must never split by reason, or the placeholder becomes an oracle for whether a page
 * exists.
 */
export function macroPlaceholder(macro: Macro | string, state: MacroPlaceholderState): string {
  return withDetail(macro, i18n.t(DETAIL[state]), IS_EMPTY(state));
}

/**
 * The same sentence, with the detail supplied by the caller. For the one case the states cannot cover:
 * the LIST host resolves `:::tagged` / `:::children` and words the empty result itself (the words are
 * the host's, per the narrow seam), but the shape and the name still come from here — so a resolved
 * empty list reads like every other placeholder instead of a bare "No pages yet."
 */
export function macroPlaceholderWithDetail(macro: Macro | string, detail: string): string {
  return withDetail(macro, detail, false);
}

/**
 * The ONE sentence an unshowable page embed gets, on the top-level path and the nested one alike
 * (ADR-071). It lives here, not at either call site, because two call sites is how the two paths would
 * drift into two different sentences — and a difference between them would itself be a signal.
 * A function, not a constant, so switching language takes effect without a reload.
 */
export const deniedEmbedLabel = (): string => macroPlaceholder("embed-page", "hidden");

function withDetail(macro: Macro | string, detail: string, empty: boolean): string {
  const m = typeof macro === "string" ? lookup(macro) : macro;
  const name = m ? macroDisplayName(m) : (typeof macro === "string" ? macro : "");
  return i18n.t(empty ? "macro.placeholderEmpty" : "macro.placeholder", { name, detail });
}

/**
 * #207 (via #598's gate): the attribute that says "what is standing here is a placeholder, not content".
 *
 * The sentence alone cannot be measured. Before #600 these states rendered `…`, and the parity gate found
 * them by looking for that character; #600 replaced it with a sentence that names the macro — better for a
 * reader, invisible to the gate, and that blind spot is how an external embed reached PAPER as "not shown
 * on this surface" without any test noticing. A marker makes the state a fact a surface can be asked about,
 * in every language, without matching prose.
 */
export const PLACEHOLDER_ATTR = "data-wks-placeholder";

/** Put the placeholder sentence into `el` AND record which state it is. The only way to show one. */
export function showPlaceholder(el: Element, macro: Macro | string, state: MacroPlaceholderState): void {
  el.textContent = macroPlaceholder(macro, state);
  el.setAttribute(PLACEHOLDER_ATTR, state);
}
