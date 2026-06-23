import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import styles from "./PageTitle.module.css";

// Large page title at the top of the reading column (Group C-B, Notion/Outline style).
// Replaces the small toolbar title — establishes a clear heading→body hierarchy.
// Click-to-rename for edit-capable users (Phase 5 #6 logic, moved here); a read-only
// heading otherwise. The server re-checks page#edit on the PATCH regardless. Testids
// (page-title / page-title-input) are unchanged so the rename e2e still applies.
export function PageTitle({ title, onRename }: { title: string; onRename?: (title: string) => void }) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  useEffect(() => { if (!editing) setDraft(title); }, [title, editing]);

  const commit = () => {
    const next = draft.trim();
    setEditing(false);
    if (next && next !== title && onRename) onRename(next);
  };

  return (
    <div className={styles.wrap}>
      {editing ? (
        <input
          className={styles.input}
          data-testid="page-title-input"
          autoFocus
          value={draft}
          aria-label={t("dialogs.renamePageTitle")}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); commit(); }
            else if (e.key === "Escape") { setDraft(title); setEditing(false); }
          }}
          onBlur={commit}
        />
      ) : onRename ? (
        <button type="button" className={styles.title} data-testid="page-title" title={t("dialogs.renamePageTitle")}
          onClick={() => { setDraft(title); setEditing(true); }}>
          {title || t("common.untitled")}
        </button>
      ) : (
        <h1 className={styles.title} data-testid="page-title">{title || t("common.untitled")}</h1>
      )}
    </div>
  );
}
