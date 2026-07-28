// #158-C2 / ADR-052: code-fence syntax highlighting in an Everforest palette, driven by the
// --hl-* semantic tokens (tokens.css, light/dark) so it stays themeable and consistent with a
// Neovim Everforest setup (dogfooding). A HighlightStyle maps @lezer/highlight tags to the
// tokens; syntaxHighlighting wires it in. No new dependency (CM + lezer are already deps).
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language"
import { tags as t } from "@lezer/highlight"
import type { Extension } from "@codemirror/state"

// #505: exported so the READ surface can colour a code fence with the SAME style the editor uses. One
// definition of "what colour is a keyword", used by both — the alternative is a second palette that
// drifts, which is the failure this whole print/export line of work has been about.
export const everforestHighlightStyle = HighlightStyle.define([
  { tag: [t.keyword, t.modifier, t.controlKeyword, t.operatorKeyword], color: "var(--hl-keyword)" },
  { tag: [t.string, t.special(t.string), t.regexp], color: "var(--hl-string)" },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: "var(--hl-comment)", fontStyle: "italic" },
  { tag: [t.number, t.bool, t.atom, t.literal], color: "var(--hl-number)" },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], color: "var(--hl-function)" },
  { tag: [t.typeName, t.className, t.namespace, t.definition(t.typeName)], color: "var(--hl-type)" },
  { tag: [t.variableName, t.propertyName, t.attributeValue], color: "var(--hl-variable)" },
  { tag: [t.operator, t.derefOperator, t.punctuation, t.separator, t.bracket], color: "var(--hl-operator)" },
  // #223: this HighlightStyle is EDITOR-WIDE (not just code fences), so t.link/t.url/t.heading here also
  // colour the MARKDOWN document itself. Mapping links AND headings to --hl-meta made both render green
  // ("links & headings stuck green"). Keep only code-fence meta (tagName/attributeName/labelName) on
  // --hl-meta; route markdown links/urls to the --link token (same as the rendered .cm-lp-link), and let
  // headings inherit the foreground colour (bold only — no colour).
  { tag: [t.tagName, t.attributeName, t.labelName], color: "var(--hl-meta)" },
  { tag: [t.link, t.url], color: "var(--link)" },
  { tag: [t.heading], fontWeight: "bold" },
  { tag: [t.invalid], color: "var(--danger)" },
])

// Editor-wide highlighting (used on both the editable surface and the read-only published view
// so a code block looks identical whether you're editing or reading — ADR-056 Reading mode too).
export const everforestHighlight: Extension = syntaxHighlighting(everforestHighlightStyle)
