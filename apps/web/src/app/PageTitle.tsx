import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

// Large page title at the top of the reading column (Group C-B, Notion/Outline style),
// aligned to the same ~740px column as the body. Click-to-rename for edit-capable
// users; a read-only heading otherwise. The server re-checks page#edit on the PATCH.
// Testids (page-title / page-title-input) are unchanged so the rename e2e still applies.
const wrap = "mx-auto box-border w-full max-w-[740px] px-6 pt-6";
const title = "m-0 block w-full text-[30px] font-bold leading-tight tracking-[-0.02em] text-foreground";
// view mode: wrap to 2 lines then ellipsise (no infinite horizontal overflow / marquee).
const clamp = "[display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2] overflow-hidden";

// `pageEditing` = the PAGE edit mode (not the rename input): view mode clamps a long
// title to 2 lines; edit mode shows it in full (you must see all of it to edit it).
export function PageTitle({ title: value, onRename, editing: pageEditing = false }: { title: string; onRename?: (title: string) => void; editing?: boolean }) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  useEffect(() => { if (!editing) setDraft(value); }, [value, editing]);

  const commit = () => {
    const next = draft.trim();
    setEditing(false);
    if (next && next !== value && onRename) onRename(next);
  };

  return (
    <div className={wrap}>
      {editing ? (
        <input
          className={`${title} rounded-sm border border-border bg-background px-1.5 outline-none focus:border-[var(--accent)]`}
          data-testid="page-title-input"
          autoFocus
          value={draft}
          aria-label={t("dialogs.renamePageTitle")}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); commit(); }
            else if (e.key === "Escape") { setDraft(value); setEditing(false); }
          }}
          onBlur={commit}
        />
      ) : onRename ? (
        <button type="button" className={`${title} cursor-text text-left ${pageEditing ? "" : clamp}`} data-testid="page-title" title={value || t("dialogs.renamePageTitle")}
          onClick={() => { setDraft(value); setEditing(true); }}>
          {value || t("common.untitled")}
        </button>
      ) : (
        <h1 className={`${title} ${pageEditing ? "" : clamp}`} data-testid="page-title" title={value}>{value || t("common.untitled")}</h1>
      )}
    </div>
  );
}
