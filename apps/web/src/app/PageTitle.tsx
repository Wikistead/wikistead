import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

// Large page title at the top of the reading column (Group C-B, Notion/Outline style),
// aligned to the same ~740px column as the body. Click-to-rename for edit-capable
// users; a read-only heading otherwise. The server re-checks page#edit on the PATCH.
// Testids (page-title / page-title-input) are unchanged so the rename e2e still applies.
// #212 comment 755 (2): the 740px reading column + top padding now live on the BAND's flex row (title +
// status share one row), so PageTitle just fills its flex cell — the column/padding moved to the parent.
const wrap = "box-border w-full min-w-0";
// break-words so a long unbroken token (or CJK without spaces) wraps inside the column
// instead of overflowing to the right.
// #190: the page title follows the PROSE font (--font-body) — the user's font choice / locale default —
// not the chrome font. Without this it inherits the body's --font-ui (it lives outside .cm-content, so
// the editor's --font-body doesn't reach it), so the title ignored the font selection while body did.
// No `display` here: view mode adds line-clamp-2 (which needs display:-webkit-box), edit/full mode adds
// `block`. A `block` in this base would override line-clamp's display and defeat the clamp (#212/780).
const title = "m-0 w-full text-[30px] font-bold leading-tight tracking-[-0.02em] text-foreground break-words [overflow-wrap:anywhere] [font-family:var(--font-body)]";
// #212 comment 780 (2) / #312: the STATIC title (button/h1) clamps to at most TWO lines with an
// ellipsis on EVERY surface — view AND page-edit mode (the old `pageEditing ? block` branch let a
// long title grow the band to 4 rows in edit mode; "you must see every line to edit" only holds for
// the rename TEXTAREA, which still wraps in full). The full title shows on hover (`title` attr) and
// in the click-to-rename textarea. The band height stays bounded (max two rows).
const clamp = "line-clamp-2";

// The rename field is a textarea (not an input) so editing a long title wraps too.
export function PageTitle({ title: value, onRename }: { title: string; onRename?: (title: string) => void }) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const taRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (!editing) setDraft(value); }, [value, editing]);

  // Auto-grow the rename textarea to fit its wrapped content (no inner scroll).
  const grow = (el: HTMLTextAreaElement | null) => { if (el) { el.style.height = "auto"; el.style.height = `${el.scrollHeight}px`; } };
  useEffect(() => { if (editing) grow(taRef.current); }, [editing, draft]);

  const commit = () => {
    const next = draft.trim();
    setEditing(false);
    if (next && next !== value && onRename) onRename(next);
  };

  return (
    <div className={wrap}>
      {editing ? (
        <textarea
          ref={taRef}
          className={`${title} block resize-none overflow-hidden rounded-sm border border-border bg-background px-1.5 outline-none focus:border-[var(--accent)]`}
          data-testid="page-title-input"
          rows={1}
          autoFocus
          value={draft}
          aria-label={t("dialogs.renamePageTitle")}
          onChange={(e) => setDraft(e.target.value.replace(/\n/g, ""))} // a title has no newlines; Enter commits
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); commit(); }
            else if (e.key === "Escape") { setDraft(value); setEditing(false); }
          }}
          onBlur={commit}
        />
      ) : onRename ? (
        <button type="button" className={`${title} cursor-text text-left ${clamp}`} data-testid="page-title" title={value || t("dialogs.renamePageTitle")}
          onClick={() => { setDraft(value); setEditing(true); }}>
          {value || t("common.untitled")}
        </button>
      ) : (
        <h1 className={`${title} ${clamp}`} data-testid="page-title" title={value}>{value || t("common.untitled")}</h1>
      )}
    </div>
  );
}
