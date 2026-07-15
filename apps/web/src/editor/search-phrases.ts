import type { TFunction } from "i18next";

// #402 the CM find/replace panel localizes through EditorState.phrases — CM looks its BUILT-IN
// English strings up in this map, so the keys below must stay byte-identical to @codemirror/search's
// phrase() calls (Find/Replace inputs, the five buttons, the checkbox labels, the a11y announcements,
// and the goto-line dialog). Values come from i18n (editorSearch.*); English resolves to the originals.
export function buildSearchPhrases(t: TFunction): Record<string, string> {
  return {
    "Find": t("editorSearch.find"),
    "Replace": t("editorSearch.replacePlaceholder"),
    "next": t("editorSearch.next"),
    "previous": t("editorSearch.previous"),
    "all": t("editorSearch.all"),
    "match case": t("editorSearch.matchCase"),
    "by word": t("editorSearch.byWord"),
    "regexp": t("editorSearch.regexp"),
    "replace": t("editorSearch.replace"),
    "replace all": t("editorSearch.replaceAll"),
    "close": t("editorSearch.close"),
    "current match": t("editorSearch.currentMatch"),
    "replaced $ matches": t("editorSearch.replacedMatches"),
    "replaced match on line $": t("editorSearch.replacedOnLine"),
    "on line": t("editorSearch.onLine"),
    "Go to line": t("editorSearch.goToLine"),
    "go": t("editorSearch.go"),
  };
}
